#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(mobileRoot, '../..');
const androidRoot = join(mobileRoot, 'android');
const iosRoot = join(mobileRoot, 'ios');
const scheme = 'AiDBStudio';

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, env = process.env) {
  console.log(`[native-build] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsVerbatimArguments: process.platform === 'win32',
  });
  if (result.error?.code === 'ENOENT') fail(`Required native tool not found: ${command}`);
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? 'unknown'}`);
}

function requireSupportedNode() {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const required = String(rootPackage.engines?.node ?? '>=22.13').match(/(\d+)\.(\d+)/);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!required || major < Number(required[1]) || (major === Number(required[1]) && minor < Number(required[2]))) {
    fail(`Node ${rootPackage.engines?.node ?? '>=22.13'} is required; current runtime is ${process.version}.`);
  }
}

function runGradle(task, artifact) {
  const windows = process.platform === 'win32';
  const wrapper = join(androidRoot, windows ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) fail(`Gradle wrapper is missing: ${wrapper}`);
  if (windows) {
    // Fixed task names contain no shell metacharacters; quote the wrapper path for spaces.
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `call "${wrapper}" ${task}`], androidRoot);
  } else {
    run(wrapper, [task], androidRoot);
  }
  const output = join(androidRoot, 'app/build/outputs', artifact);
  if (!existsSync(output)) fail(`Gradle completed without producing the expected artifact: ${output}`);
  console.log(`[native-build] Android artifact: ${output}`);
}

function requireMacOS() {
  if (process.platform !== 'darwin') fail('iOS builds require macOS with Xcode and CocoaPods.');
}

function runIos(mode) {
  requireMacOS();
  run('xcodebuild', ['-version'], iosRoot);
  run('pod', ['--version'], iosRoot);
  run('pod', ['install'], iosRoot);
  mkdirSync(join(iosRoot, 'build'), { recursive: true });

  const workspace = join(iosRoot, 'AiDBStudio.xcworkspace');
  if (!existsSync(workspace)) fail(`CocoaPods workspace was not created: ${workspace}`);

  if (mode === 'ios-simulator') {
    const derivedDataPath = join(iosRoot, 'build/DerivedData-Simulator');
    run('xcodebuild', [
      '-workspace', workspace,
      '-scheme', scheme,
      '-configuration', 'Release',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', derivedDataPath,
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ], iosRoot);
    const app = join(derivedDataPath, 'Build/Products/Release-iphonesimulator', `${scheme}.app`);
    if (!existsSync(app)) fail(`xcodebuild completed without producing the expected simulator app: ${app}`);
    console.log(`[native-build] iOS simulator app: ${app}`);
    return;
  }

  const archivePath = join(iosRoot, 'build', `${scheme}.xcarchive`);
  const args = [
    '-workspace', workspace,
    '-scheme', scheme,
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS',
    '-archivePath', archivePath,
    '-allowProvisioningUpdates',
  ];
  // Optional local automatic-signing team selection; EAS uses remote credentials instead.
  if (process.env.DEVELOPMENT_TEAM?.trim()) args.push(`DEVELOPMENT_TEAM=${process.env.DEVELOPMENT_TEAM.trim()}`);
  args.push('archive');
  run('xcodebuild', args, iosRoot);
  if (!existsSync(archivePath)) fail(`xcodebuild completed without producing the expected archive: ${archivePath}`);
  console.log(`[native-build] iOS archive: ${archivePath}`);
  console.log('[native-build] Upload the archive through Xcode/EAS, or use eas submit --profile production.');
}

const command = process.argv[2];
const commands = new Set(['android-debug', 'android-release', 'ios-simulator', 'ios-archive']);
if (!commands.has(command)) {
  console.error('Usage: node scripts/native-build.mjs <android-debug|android-release|ios-simulator|ios-archive>');
  process.exit(2);
}

try {
  requireSupportedNode();
  if (command === 'android-debug') runGradle(':app:assembleDebug', 'apk/debug/app-debug.apk');
  if (command === 'android-release') runGradle(':app:bundleRelease', 'bundle/release/app-release.aab');
  if (command === 'ios-simulator' || command === 'ios-archive') runIos(command);
} catch (error) {
  console.error(`[native-build] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
