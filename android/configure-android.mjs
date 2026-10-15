import Fs from 'fs'
import Path from 'path'
import { execSync } from 'child_process'
import C from './util/common.js'

const NDK = `${process.env.HOME}/Library/Android/sdk/ndk/28.2.13676358`
const env = { ...process.env, ...C.depotTools.env, DEPOT_TOOLS_UPDATE: '0' }

if (!process.argv.includes('--no-sync')) {
	process.chdir(C.dir.dawn)
	await Fs.promises.cp('scripts/standalone-with-node.gclient', '.gclient')
	execSync('gclient sync --no-history -j8', { stdio: 'inherit', env })
	process.chdir(C.dir.abseil)
	execSync(`git apply --ignore-space-change --ignore-whitespace "${Path.join(C.dir.root, 'abseil-cpp.patch')}"`, { stdio: 'inherit' })
}

process.chdir(C.dir.dawn)
await Fs.promises.rm(C.dir.build, { recursive: true }).catch(() => {})
await Fs.promises.mkdir(C.dir.build, { recursive: true })
execSync(`cmake ${[
	'-S', `"${C.dir.dawn}"`, '-B', `"${C.dir.build}"`, '-GNinja',
	'-DCMAKE_BUILD_TYPE=Release',
	`-DCMAKE_TOOLCHAIN_FILE=${NDK}/build/cmake/android.toolchain.cmake`,
	'-DANDROID_ABI=arm64-v8a',
	'-DANDROID_PLATFORM=android-29',
	'-DANDROID_STL=c++_shared',
	'-DANDROID_ALLOW_UNDEFINED_SYMBOLS=TRUE',
	'-DDAWN_BUILD_NODE_BINDINGS=ON',
	'-DDAWN_BUILD_SAMPLES=OFF',
	'-DTINT_BUILD_TESTS=OFF',
	'-DTINT_BUILD_CMD_TOOLS=OFF',
	'-DDAWN_USE_GLFW=OFF',
	'-DDAWN_SUPPORTS_GLFW_FOR_WINDOWING=OFF',
	'-DDAWN_ENABLE_PIC=ON',
	'-DDAWN_ENABLE_SPIRV_VALIDATION=OFF',
	'-DTINT_BUILD_SPV_READER=OFF',
	'-DDAWN_FORCE_SYSTEM_COMPONENT_LOAD=ON',
	'-DDAWN_SUPPORTS_CXX_MODULES=OFF',
	'-DDAWN_USE_X11=OFF',
	'-DDAWN_BUILD_PROTOBUF=OFF',
	'-DTINT_BUILD_IR_BINARY=OFF',
	'-DDAWN_USE_WAYLAND=OFF',
	'-DDAWN_ENABLE_VULKAN=ON',
	'-DDAWN_ENABLE_OPENGLES=OFF',
	'-DDAWN_ENABLE_DESKTOP_GL=OFF',
].join(' ')}`, { stdio: 'inherit', env })
