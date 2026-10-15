/**
 * wosu! Android launcher. A NativeActivity (no Java) that runs the game on
 * Node.js (libnode.so) exactly like the desktop SDL host: android_main keeps
 * the activity's looper turning and queues window / touch / key events; the
 * Node thread runs android/host.mjs, which loads this same library as a
 * Node-API addon ("bridge") to read those events and the ANativeWindow.
 */
#include <android/asset_manager.h>
#include <android/log.h>
#include <android/native_window.h>
#include <android/window.h>
#include <android_native_app_glue.h>
#include <dlfcn.h>
#include <node_api.h>
#include <pthread.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

namespace node {
int Start(int argc, char* argv[]);
}

#define TAG "wosu"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

enum EventType {
    EV_WINDOW = 1,       // a (new) window to render into
    EV_WINDOW_LOST = 2,  // stop using the window, then call bridge.ackWindowLost()
    EV_RESIZE = 3,
    EV_TOUCH = 4,
    EV_KEY = 5,
    EV_FOCUS = 6,
    EV_PAUSE = 7,
    EV_RESUME = 8,
};

enum TouchAction { T_DOWN = 0, T_MOVE = 1, T_UP = 2, T_CANCEL = 3 };

struct Event {
    int type;
    int action;  // touch: TouchAction; key: 0 down / 1 up; focus: 0/1
    int id;      // touch: pointer id; key: Android keycode
    float x, y;
    double time;  // CLOCK_MONOTONIC ms
    int meta;     // key: meta state; touch: tool type
};

std::mutex qMutex;
std::deque<Event> queue;
ANativeWindow* window = nullptr;  // guarded by qMutex
int windowW = 0, windowH = 0;

std::mutex lostMutex;
std::condition_variable lostCv;
bool lostAcked = false;

android_app* gApp = nullptr;
std::string filesDir, externalDir, libDir, cacheDir;
std::atomic<bool> nodeRunning{false};

double nowMs() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

void push(const Event& e) {
    std::lock_guard<std::mutex> lock(qMutex);
    queue.push_back(e);
}

// --- stdout / stderr → logcat ------------------------------------------------

void* pipeToLog(void* arg) {
    int fd = (int)(intptr_t)arg;
    char buf[4096];
    std::string line;
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf)) > 0) {
        line.append(buf, n);
        size_t nl;
        while ((nl = line.find('\n')) != std::string::npos) {
            __android_log_write(ANDROID_LOG_INFO, "wosu-js", line.substr(0, nl).c_str());
            line.erase(0, nl + 1);
        }
    }
    return nullptr;
}

void redirectStdio() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    int fds[2];
    pipe(fds);
    dup2(fds[1], 1);
    dup2(fds[1], 2);
    pthread_t t;
    pthread_create(&t, nullptr, pipeToLog, (void*)(intptr_t)fds[0]);
    pthread_detach(t);
}

// --- assets → files/app ------------------------------------------------------

void mkdirs(const std::string& path) {
    for (size_t i = 1; i < path.size(); i++) {
        if (path[i] == '/') mkdir(path.substr(0, i).c_str(), 0755);
    }
    mkdir(path.c_str(), 0755);
}

std::string readAsset(AAssetManager* am, const char* name) {
    AAsset* a = AAssetManager_open(am, name, AASSET_MODE_BUFFER);
    if (!a) return {};
    std::string s((const char*)AAsset_getBuffer(a), AAsset_getLength(a));
    AAsset_close(a);
    return s;
}

std::string readFile(const std::string& path) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return {};
    std::string s;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
    fclose(f);
    return s;
}

/** The game's files ship as assets listed in app.list; unpacked once per build (app.stamp). */
void extractApp(AAssetManager* am) {
    std::string root = filesDir + "/app";
    std::string stamp = readAsset(am, "app.stamp");
    if (!stamp.empty() && readFile(root + "/.stamp") == stamp) return;
    double t0 = nowMs();
    std::string list = readAsset(am, "app.list");
    system(("rm -rf '" + root + "'").c_str());
    size_t pos = 0, count = 0;
    while (pos < list.size()) {
        size_t nl = list.find('\n', pos);
        if (nl == std::string::npos) nl = list.size();
        std::string rel = list.substr(pos, nl - pos);
        pos = nl + 1;
        if (rel.empty()) continue;
        std::string dst = root + "/" + rel;
        mkdirs(dst.substr(0, dst.rfind('/')));
        // "a -> b": a symlink (native addons live in the APK's lib dir).
        size_t arrow = rel.find(" -> ");
        if (arrow != std::string::npos) {
            std::string link = root + "/" + rel.substr(0, arrow);
            std::string target = libDir + "/" + rel.substr(arrow + 4);
            mkdirs(link.substr(0, link.rfind('/')));
            symlink(target.c_str(), link.c_str());
            continue;
        }
        AAsset* a = AAssetManager_open(am, ("app/" + rel).c_str(), AASSET_MODE_STREAMING);
        if (!a) {
            LOGE("missing asset %s", rel.c_str());
            continue;
        }
        FILE* f = fopen(dst.c_str(), "wb");
        char buf[65536];
        int n;
        while ((n = AAsset_read(a, buf, sizeof buf)) > 0) fwrite(buf, 1, n, f);
        fclose(f);
        AAsset_close(a);
        count++;
    }
    FILE* f = fopen((root + "/.stamp").c_str(), "wb");
    fwrite(stamp.data(), 1, stamp.size(), f);
    fclose(f);
    LOGI("unpacked %zu files in %.0f ms", count, nowMs() - t0);
}

// --- Node thread -------------------------------------------------------------

void* runNode(void*) {
    std::string entry = filesDir + "/app/android/host.mjs";
    // node::Start rewrites argv in place (uv_setup_args): one contiguous block.
    std::vector<std::string> args = {"node", "--expose-gc", "--max-semi-space-size=32", entry};
    std::string block;
    for (auto& a : args) block += a + '\0';
    char* mem = (char*)malloc(block.size());
    memcpy(mem, block.data(), block.size());
    std::vector<char*> argv;
    for (size_t i = 0; i < block.size(); i += strlen(mem + i) + 1) argv.push_back(mem + i);
    argv.push_back(nullptr);
    setenv("HOME", filesDir.c_str(), 1);
    setenv("TMPDIR", cacheDir.c_str(), 1);
    setenv("WOSU_DATA_DIR", (externalDir + "/wosu").c_str(), 1);
    setenv("WOSU_APP_DIR", (filesDir + "/app").c_str(), 1);
    setenv("WOSU_LIB_DIR", libDir.c_str(), 1);
    LOGI("starting node %s", entry.c_str());
    nodeRunning = true;
    int code = node::Start((int)argv.size() - 1, argv.data());
    LOGI("node exited with %d", code);
    nodeRunning = false;
    _exit(code);
    return nullptr;
}

void startNode() {
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    // V8 assumes a desktop-sized stack (~1 MB limit); Android threads default to 1 MB total.
    pthread_attr_setstacksize(&attr, 64 << 20);
    pthread_t t;
    pthread_create(&t, &attr, runNode, nullptr);
    pthread_attr_destroy(&attr);
}

// --- activity events ---------------------------------------------------------

void setWindow(ANativeWindow* w) {
    std::lock_guard<std::mutex> lock(qMutex);
    if (window) ANativeWindow_release(window);
    window = w;
    if (w) {
        ANativeWindow_acquire(w);
        windowW = ANativeWindow_getWidth(w);
        windowH = ANativeWindow_getHeight(w);
    }
}

void onAppCmd(android_app* app, int32_t cmd) {
    switch (cmd) {
        case APP_CMD_INIT_WINDOW:
            setWindow(app->window);
            push({EV_WINDOW, 0, 0, (float)windowW, (float)windowH, nowMs(), 0});
            break;
        case APP_CMD_TERM_WINDOW: {
            // The surface dies when this returns: wait (bounded) for the renderer to let go.
            {
                std::lock_guard<std::mutex> lock(lostMutex);
                lostAcked = false;
            }
            push({EV_WINDOW_LOST, 0, 0, 0, 0, nowMs(), 0});
            if (nodeRunning) {
                std::unique_lock<std::mutex> lock(lostMutex);
                lostCv.wait_for(lock, std::chrono::milliseconds(1500), [] { return lostAcked; });
            }
            setWindow(nullptr);
            break;
        }
        case APP_CMD_WINDOW_RESIZED:
        case APP_CMD_CONFIG_CHANGED:
        case APP_CMD_CONTENT_RECT_CHANGED:
            if (app->window) {
                int w = ANativeWindow_getWidth(app->window), h = ANativeWindow_getHeight(app->window);
                bool changed;
                {
                    std::lock_guard<std::mutex> lock(qMutex);
                    changed = w != windowW || h != windowH;
                    windowW = w;
                    windowH = h;
                }
                if (changed) push({EV_RESIZE, 0, 0, (float)w, (float)h, nowMs(), 0});
            }
            break;
        case APP_CMD_GAINED_FOCUS:
            push({EV_FOCUS, 1, 0, 0, 0, nowMs(), 0});
            break;
        case APP_CMD_LOST_FOCUS:
            push({EV_FOCUS, 0, 0, 0, 0, nowMs(), 0});
            break;
        case APP_CMD_PAUSE:
            push({EV_PAUSE, 0, 0, 0, 0, nowMs(), 0});
            break;
        case APP_CMD_RESUME:
            push({EV_RESUME, 0, 0, 0, 0, nowMs(), 0});
            break;
        default:
            break;
    }
}

void pushPointer(const AInputEvent* e, size_t i, int action, double time) {
    push({EV_TOUCH, action, AMotionEvent_getPointerId(e, i), AMotionEvent_getX(e, i), AMotionEvent_getY(e, i), time,
          AMotionEvent_getToolType(e, i)});
}

int32_t onInput(android_app*, AInputEvent* e) {
    int32_t type = AInputEvent_getType(e);
    if (type == AINPUT_EVENT_TYPE_MOTION) {
        int32_t a = AMotionEvent_getAction(e);
        int32_t masked = a & AMOTION_EVENT_ACTION_MASK;
        size_t index = (a & AMOTION_EVENT_ACTION_POINTER_INDEX_MASK) >> AMOTION_EVENT_ACTION_POINTER_INDEX_SHIFT;
        size_t count = AMotionEvent_getPointerCount(e);
        double t = AMotionEvent_getEventTime(e) / 1e6;
        switch (masked) {
            case AMOTION_EVENT_ACTION_DOWN:
            case AMOTION_EVENT_ACTION_POINTER_DOWN:
                pushPointer(e, index, T_DOWN, t);
                break;
            case AMOTION_EVENT_ACTION_UP:
            case AMOTION_EVENT_ACTION_POINTER_UP:
                pushPointer(e, index, T_UP, t);
                break;
            case AMOTION_EVENT_ACTION_CANCEL:
                for (size_t i = 0; i < count; i++) pushPointer(e, i, T_CANCEL, t);
                break;
            case AMOTION_EVENT_ACTION_MOVE:
            case AMOTION_EVENT_ACTION_HOVER_MOVE: {
                // Batched samples since the last event, each with its own timestamp.
                size_t hist = AMotionEvent_getHistorySize(e);
                for (size_t h = 0; h < hist; h++) {
                    double ht = AMotionEvent_getHistoricalEventTime(e, h) / 1e6;
                    for (size_t i = 0; i < count; i++) {
                        push({EV_TOUCH, T_MOVE, AMotionEvent_getPointerId(e, i), AMotionEvent_getHistoricalX(e, i, h),
                              AMotionEvent_getHistoricalY(e, i, h), ht, AMotionEvent_getToolType(e, i)});
                    }
                }
                for (size_t i = 0; i < count; i++) pushPointer(e, i, T_MOVE, t);
                break;
            }
            default:
                return 0;
        }
        return 1;
    }
    if (type == AINPUT_EVENT_TYPE_KEY) {
        int32_t code = AKeyEvent_getKeyCode(e);
        // Volume keys keep working as volume keys.
        if (code == AKEYCODE_VOLUME_UP || code == AKEYCODE_VOLUME_DOWN || code == AKEYCODE_VOLUME_MUTE) return 0;
        int32_t a = AKeyEvent_getAction(e);
        if (a != AKEY_EVENT_ACTION_DOWN && a != AKEY_EVENT_ACTION_UP) return 0;
        push({EV_KEY, a == AKEY_EVENT_ACTION_UP ? 1 : 0, code, 0, 0, AKeyEvent_getEventTime(e) / 1e6,
              AKeyEvent_getMetaState(e)});
        return 1;
    }
    return 0;
}

// --- Node-API bridge -----------------------------------------------------------

napi_value num(napi_env env, double v) {
    napi_value r;
    napi_create_double(env, v, &r);
    return r;
}

napi_value str(napi_env env, const std::string& s) {
    napi_value r;
    napi_create_string_utf8(env, s.c_str(), s.size(), &r);
    return r;
}

void set(napi_env env, napi_value obj, const char* key, napi_value v) {
    napi_set_named_property(env, obj, key, v);
}

/** poll() → Float64Array of events, 7 numbers each: type, action, id, x, y, time, meta. */
napi_value Poll(napi_env env, napi_callback_info) {
    std::deque<Event> events;
    {
        std::lock_guard<std::mutex> lock(qMutex);
        events.swap(queue);
    }
    napi_value ab, arr;
    void* data;
    size_t n = events.size() * 7;
    napi_create_arraybuffer(env, n * sizeof(double), &data, &ab);
    double* d = (double*)data;
    for (const Event& e : events) {
        *d++ = e.type;
        *d++ = e.action;
        *d++ = e.id;
        *d++ = e.x;
        *d++ = e.y;
        *d++ = e.time;
        *d++ = e.meta;
    }
    napi_create_typedarray(env, napi_float64_array, n, ab, 0, &arr);
    return arr;
}

/** window() → { gpu: Buffer(ANativeWindow*), width, height } or null. */
napi_value Window(napi_env env, napi_callback_info) {
    std::lock_guard<std::mutex> lock(qMutex);
    napi_value r;
    if (!window) {
        napi_get_null(env, &r);
        return r;
    }
    napi_create_object(env, &r);
    void* data;
    napi_value buf;
    napi_create_buffer(env, sizeof(void*), &data, &buf);
    memcpy(data, &window, sizeof(void*));
    set(env, r, "gpu", buf);
    set(env, r, "width", num(env, windowW));
    set(env, r, "height", num(env, windowH));
    return r;
}

napi_value AckWindowLost(napi_env env, napi_callback_info) {
    {
        std::lock_guard<std::mutex> lock(lostMutex);
        lostAcked = true;
    }
    lostCv.notify_all();
    napi_value r;
    napi_get_undefined(env, &r);
    return r;
}

napi_value Now(napi_env env, napi_callback_info) {
    return num(env, nowMs());
}

napi_value Info(napi_env env, napi_callback_info) {
    napi_value r;
    napi_create_object(env, &r);
    set(env, r, "files", str(env, filesDir));
    set(env, r, "external", str(env, externalDir));
    set(env, r, "lib", str(env, libDir));
    set(env, r, "cache", str(env, cacheDir));
    AConfiguration* c = gApp ? gApp->config : nullptr;
    set(env, r, "density", num(env, c ? AConfiguration_getDensity(c) : 160));
    set(env, r, "sdk", num(env, c ? AConfiguration_getSdkVersion(c) : 0));
    return r;
}

/** setPriority(nice): this (JS) thread's nice value, -20..19. */
napi_value SetPriority(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int32_t nice = 0;
    napi_get_value_int32(env, argv[0], &nice);
    int ok = setpriority(PRIO_PROCESS, gettid(), nice);
    napi_value r;
    napi_get_boolean(env, ok == 0, &r);
    return r;
}

napi_value Finish(napi_env env, napi_callback_info) {
    if (gApp) ANativeActivity_finish(gApp->activity);
    napi_value r;
    napi_get_undefined(env, &r);
    return r;
}

}  // namespace

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    struct {
        const char* name;
        napi_callback fn;
    } fns[] = {
        {"poll", Poll}, {"window", Window}, {"ackWindowLost", AckWindowLost}, {"now", Now},
        {"info", Info}, {"setPriority", SetPriority}, {"finish", Finish},
    };
    for (auto& f : fns) {
        napi_value v;
        napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &v);
        set(env, exports, f.name, v);
    }
    return exports;
}

extern "C" __attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1() {
    return NAPI_VERSION;
}

void android_main(android_app* app) {
    gApp = app;
    app->onAppCmd = onAppCmd;
    app->onInputEvent = onInput;
    redirectStdio();
    ANativeActivity_setWindowFlags(app->activity, AWINDOW_FLAG_KEEP_SCREEN_ON | AWINDOW_FLAG_FULLSCREEN, 0);

    filesDir = app->activity->internalDataPath;
    externalDir = app->activity->externalDataPath ? app->activity->externalDataPath : filesDir;
    mkdirs(externalDir);
    cacheDir = filesDir + "/../cache";
    Dl_info dl;
    dladdr((void*)&android_main, &dl);
    libDir = dl.dli_fname;
    libDir = libDir.substr(0, libDir.rfind('/'));
    LOGI("files=%s external=%s lib=%s", filesDir.c_str(), externalDir.c_str(), libDir.c_str());

    extractApp(app->activity->assetManager);
    startNode();

    while (!app->destroyRequested) {
        int events;
        android_poll_source* source;
        if (ALooper_pollOnce(-1, nullptr, &events, (void**)&source) >= 0 && source) source->process(app, source);
    }
    _exit(0);
}
