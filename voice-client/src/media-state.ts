export type MediaPreferences = { voice: boolean; camera: boolean; sfuCamera: boolean; publishingCamera: boolean; sfuPublishingCamera: boolean }
export type MediaDemand = { voice: boolean; camera: boolean }
export const defaultMediaPreferences = (): MediaPreferences => ({voice:true,camera:true,sfuCamera:false,publishingCamera:false,sfuPublishingCamera:false})
export const mediaPreferenceFlags = (state: MediaPreferences) => (state.voice?1:0)|(state.camera?2:0)|(state.sfuCamera?4:0)|(state.publishingCamera?8:0)|(state.sfuPublishingCamera?16:0)
