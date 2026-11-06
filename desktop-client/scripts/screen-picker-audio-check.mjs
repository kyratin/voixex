/** Production capture-handler contract: native picker shortcut must not bypass audio selection. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const mainUrl=new URL('../src/main.ts',import.meta.url)
const text=await readFile(mainUrl,'utf8')
const source=ts.createSourceFile(mainUrl.pathname,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
let handlerCall
function visit(node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='setDisplayMediaRequestHandler')handlerCall=node
  ts.forEachChild(node,visit)
}
visit(source)
assert.ok(handlerCall,'Production main must register its display media handler')
const options=handlerCall.arguments[1]
assert.ok(options&&ts.isObjectLiteralExpression(options),'Display media handler must explicitly configure its picker')
const picker=options.properties.find(property=>ts.isPropertyAssignment(property)&&property.name.getText(source)==='useSystemPicker')
assert.ok(picker&&picker.initializer.kind===ts.SyntaxKind.FalseKeyword,'Native picker returns video only: production must explicitly useSystemPicker:false')
const handler=handlerCall.arguments[0]
assert.ok(ts.isArrowFunction(handler),'Expected production capture callback')
const factory=new Function('desktopCapturer','preferredScreenSourceId','process',`return (${handler.getText(source)})`)
const sources=[{id:'screen:1:0',name:'First display'},{id:'window:2:0',name:'Selected application'}]
for(const platform of ['darwin','win32']){
  for(const audioRequested of [true,false]){
    let result
    const callback=factory({getSources:async options=>{assert.deepEqual(options.types,['screen','window']);return sources}},sources[1].id,{platform})
    await callback({audioRequested},value=>result=value)
    assert.equal(result.video,sources[1],'Existing source selector must be honored')
    assert.equal(result.audio,audioRequested?'loopback':undefined,'Audio selection must reach the Electron handler')
  }
}
let empty
await factory({getSources:async()=>[]},null,{platform:'darwin'})({audioRequested:true},value=>empty=value)
assert.deepEqual(empty,{})
console.log('PASS production display capture: custom picker path, selected source, explicit audio on/off, no-source cancellation')
