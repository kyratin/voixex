// Dedicated process: stdout is 48 kHz stereo float32 LE PCM; stderr is status.
// Never fall back to endpoint loopback: it would include the call's playback.
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl.h>
#include <wrl/implements.h>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <io.h>
#include <vector>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
void check(HRESULT hr, const char* operation) {
  if (FAILED(hr)) {
    char message[160];
    snprintf(message, sizeof(message), "%s: HRESULT 0x%08lx", operation, static_cast<unsigned long>(hr));
    throw std::runtime_error(message);
  }
}
class Activation final : public Microsoft::WRL::RuntimeClass<
  Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
  Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_PENDING;
  ComPtr<IUnknown> audio;
  ~Activation() { if (done) CloseHandle(done); }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activationResult = E_FAIL;
    result = operation->GetActivateResult(&activationResult, &audio);
    if (SUCCEEDED(result)) result = activationResult;
    SetEvent(done);
    return S_OK;
  }
};

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  wchar_t* end = nullptr;
  const auto pid = wcstoul(argv[1], &end, 10);
  if (!pid || !end || *end) return 2;
  // Parent exit always ends capture, even if Electron cannot run cleanup.
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!parent) return 3;
  HANDLE samples = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!samples) { CloseHandle(parent); return 3; }
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  int exitCode = 0;
  try {
    check(initialized, "CoInitializeEx");
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT property{};
    property.vt = VT_BLOB;
    property.blob.cbSize = sizeof(params);
    property.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto activation = Microsoft::WRL::Make<Activation>();
    if (!activation || !activation->done) throw std::runtime_error("Activation event unavailable");
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
      &property, activation.Get(), &operation), "ActivateAudioInterfaceAsync");
    if (WaitForSingleObject(activation->done, 8000) != WAIT_OBJECT_0)
      throw std::runtime_error("Audio activation timed out");
    check(activation->result, "Process loopback activation");
    ComPtr<IAudioClient> client;
    check(activation->audio.As(&client), "IAudioClient");
    WAVEFORMATEXTENSIBLE format{};
    format.Format = {WAVE_FORMAT_EXTENSIBLE, 2, 48000, 48000 * 8, 8, 32, 22};
    format.Samples.wValidBitsPerSample = 32;
    format.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, embedded to avoid a GUID-library dependency.
    format.SubFormat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      200000, 0, &format.Format, nullptr), "Initialize");
    check(client->SetEventHandle(samples), "SetEventHandle");
    ComPtr<IAudioCaptureClient> capture;
    check(client->GetService(IID_PPV_ARGS(&capture)), "IAudioCaptureClient");
    _setmode(_fileno(stdout), _O_BINARY);
    setvbuf(stdout, nullptr, _IONBF, 0);
    check(client->Start(), "Start");
    fprintf(stderr, "READY 48000 2 f32\n");
    fflush(stderr);
    const HANDLE events[] = {parent, samples};
    std::vector<BYTE> silence;
    for (;;) {
      const DWORD event = WaitForMultipleObjects(2, events, FALSE, 1000);
      if (event == WAIT_OBJECT_0) break;
      if (event == WAIT_FAILED) throw std::runtime_error("Audio event wait failed");
      UINT32 available = 0;
      check(capture->GetNextPacketSize(&available), "GetNextPacketSize");
      while (available) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        check(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr), "GetBuffer");
        const size_t bytes = static_cast<size_t>(frames) * 8;
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          silence.assign(bytes, 0);
          data = silence.data();
        }
        const bool written = fwrite(data, 1, bytes, stdout) == bytes;
        check(capture->ReleaseBuffer(frames), "ReleaseBuffer");
        if (!written) throw std::runtime_error("Audio output pipe closed");
        check(capture->GetNextPacketSize(&available), "GetNextPacketSize");
      }
    }
    client->Stop();
  } catch (const std::exception& error) {
    fprintf(stderr, "ERROR %s\n", error.what());
    fflush(stderr);
    exitCode = 1;
  }
  if (SUCCEEDED(initialized)) CoUninitialize();
  CloseHandle(samples);
  CloseHandle(parent);
  return exitCode;
}
