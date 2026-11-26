#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(mobileRoot, path), 'utf8');
const checks = [];

function check(name, run) {
  run();
  checks.push(name);
}

function plistString(xml, key) {
  const match = xml.match(new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</key>\\s*<string>([^<]+)</string>`));
  return match?.[1];
}

try {
  const app = JSON.parse(read('app.json')).expo;
  const mobilePackage = JSON.parse(read('package.json'));
  const eas = JSON.parse(read('eas.json'));
  const androidRootGradle = read('android/build.gradle');
  const androidSettings = read('android/settings.gradle');
  const androidGradle = read('android/app/build.gradle');
  const androidProperties = read('android/gradle.properties');
  const gradleWrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
  const iosPodfile = read('ios/Podfile');
  const iosPodProperties = JSON.parse(read('ios/Podfile.properties.json'));
  const iosAppDelegate = read('ios/AiDBStudio/AppDelegate.swift');
  const iosSceneDelegate = read('ios/AiDBStudio/SceneDelegate.swift');
  const iosProject = read('ios/AiDBStudio.xcodeproj/project.pbxproj');
  const infoPlist = read('ios/AiDBStudio/Info.plist');
  const scheme = read('ios/AiDBStudio.xcodeproj/xcshareddata/xcschemes/AiDBStudio.xcscheme');
  const privacy = read('ios/AiDBStudio/PrivacyInfo.xcprivacy');
  const nativeBuild = read('scripts/native-build.mjs');
  const production = eas.build.production;

  check('mobile runs the Expo SDK 58 / React Native 0.88 / React 19 baseline', () => {
    const dependencies = mobilePackage.dependencies;
    assert.match(dependencies.expo, /^~58\./);
    assert.equal(dependencies['react-native'], '0.88.1');
    assert.equal(dependencies.react, '19.3.0');
    assert.equal(dependencies['react-dom'], '19.3.0');
    assert.match(dependencies['react-native-web'], /^~0\.21\./);
    assert.match(dependencies['@expo/metro-runtime'], /^~58\./);
    for (const name of ['expo-camera', 'expo-document-picker', 'expo-file-system', 'expo-image-picker', 'expo-linking', 'expo-secure-store', 'expo-sharing', 'expo-status-bar']) {
      assert.match(dependencies[name], /^~58\./, `${name} must use the SDK 58 compatibility range`);
    }
    assert.equal(dependencies['react-native-zeroconf'], '1.0.0-rc.3');
    assert.equal(mobilePackage.devDependencies['@types/react'], '~19.3.1');
    assert.equal(mobilePackage.devDependencies.typescript, '~6.0.3');
    assert.notEqual(app.newArchEnabled, false);
  });

  check('Android uses the SDK 58 native toolchain, New Architecture and Hermes', () => {
    assert.match(androidRootGradle, /apply plugin: "expo-root-project"/);
    assert.match(androidSettings, /id\("expo-autolinking-settings"\)/);
    assert.match(androidSettings, /expoAutolinking\.useExpoVersionCatalog\(\)/);
    assert.match(gradleWrapper, /gradle-9\.4\.1-bin\.zip/);
    assert.match(androidProperties, /^newArchEnabled=true$/m);
    assert.match(androidProperties, /^hermesEnabled=true$/m);
    assert.match(androidProperties, /^android\.enableMinifyInReleaseBuilds=true$/m);
    assert.match(androidGradle, /require\.resolve\('hermes-compiler\/package\.json'/);
    assert.match(androidGradle, /REACT_NATIVE_RELEASE_LEVEL/);
    assert.match(androidGradle, /expoLibs\.versions\.fresco/);
    assert.match(read('android/app/src/main/java/top/keiskei/aidb/MainApplication.kt'), /loadReactNative\(this\)/);
  });

  check('iOS uses the SDK 58 scene lifecycle, iOS 16.4 and precompiled React Native modules', () => {
    assert.equal(iosPodProperties.newArchEnabled, undefined);
    assert.match(iosPodfile, /platform :ios, podfile_properties\['ios\.deploymentTarget'\] \|\| '16\.4'/);
    assert.match(iosPodfile, /ENV\['RCT_USE_PREBUILT_RNCORE'\]/);
    assert.match(iosPodfile, /ENV\['EXPO_USE_PRECOMPILED_MODULES'\] \|\|= '1'/);
    assert.doesNotMatch(iosPodfile, /RCT_NEW_ARCH_ENABLED/);
    assert.match(iosPodfile, /privacy_file_aggregation_enabled/);
    assert.match(iosPodfile, /CODE_SIGNING_ALLOWED.*NO/);
    assert.match(iosAppDelegate, /ExpoReactNativeFactoryProvider/);
    assert.match(iosAppDelegate, /\.expo\/\.virtual-metro-entry/);
    assert.match(iosSceneDelegate, /class SceneDelegate: ExpoAppSceneDelegate/);
    assert.match(infoPlist, /<key>RCTNewArchEnabled<\/key>\s*<true\/>/);
    assert.match(infoPlist, /<key>UIApplicationSceneManifest<\/key>/);
    assert.match(iosProject, /objectVersion = 54;/);
    assert.match(iosProject, /AppDelegate\.swift in Sources/);
    assert.match(iosProject, /SceneDelegate\.swift in Sources/);
    assert.doesNotMatch(iosProject, /AppDelegate\.mm|main\.m in Sources|IPHONEOS_DEPLOYMENT_TARGET = 15\.1/);
    assert.equal(plistString(infoPlist, 'LSMinimumSystemVersion'), '16.4');
    assert.equal((iosProject.match(/IPHONEOS_DEPLOYMENT_TARGET = 16\.4;/g) ?? []).length, 4);
  });

  check('mobile and native version metadata agree', () => {
    assert.equal(app.version, mobilePackage.version);
    assert.match(app.ios.buildNumber, /^\d+$/);
    assert.ok(Number.isInteger(app.android.versionCode) && app.android.versionCode > 0);
    assert.match(androidGradle, new RegExp(`^\\s*versionCode\\s+${app.android.versionCode}\\s*$`, 'm'));
    assert.match(androidGradle, new RegExp(`^\\s*versionName\\s+"${app.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*$`, 'm'));
  });

  check('EAS production is a signed store build with remote credentials', () => {
    assert.equal(production.distribution, 'store');
    assert.equal(production.environment, 'production');
    assert.equal(production.credentialsSource, 'remote');
    assert.equal(production.channel, 'production');
    assert.equal(production.android.buildType, 'app-bundle');
    assert.equal(production.ios.scheme, 'AiDBStudio');
    assert.equal(production.ios.buildConfiguration, 'Release');
    assert.equal(production.ios.simulator, false);
    assert.equal(production.autoIncrement, true);
    assert.equal(eas.cli.appVersionSource, 'remote');
  });

  check('all EAS build profiles use a root-compatible Node runtime', () => {
    assert.equal(eas.build.base.node, '22.23.3');
    for (const [name, profile] of Object.entries(eas.build)) {
      assert.notEqual(profile.developmentClient, true, `${name} must not enable the absent expo-dev-client`);
      if (name === 'base') continue;
      const node = profile.extends === 'base' ? eas.build.base.node : profile.node;
      assert.ok(node, `${name} must select Node 22 explicitly`);
      const [major, minor] = node.split('.').map(Number);
      assert.ok(major === 22 && minor >= 13, `${name} must satisfy the root Node >=22.13 engine`);
    }
  });

  check('Android release uses fail-closed production signing', () => {
    const buildTypes = androidGradle.match(/buildTypes\s*\{([\s\S]*?)\n    \}/)?.[1] ?? '';
    const release = buildTypes.match(/release\s*\{([\s\S]*?)\n        \}/)?.[1] ?? '';
    assert.match(release, /signingConfig\s+signingConfigs\.release/);
    assert.doesNotMatch(release, /signingConfigs\.debug/);
    for (const name of ['MYAPP_UPLOAD_STORE_FILE', 'MYAPP_UPLOAD_STORE_PASSWORD', 'MYAPP_UPLOAD_KEY_ALIAS', 'MYAPP_UPLOAD_KEY_PASSWORD', 'MYAPP_UPLOAD_CERT_SHA256']) {
      assert.ok(androidGradle.includes(name), `missing ${name}`);
    }
    assert.match(androidGradle, /findProperty\(name\)\s*\?:\s*System\.getenv\(name\)/);
    assert.match(androidGradle, /tasks\.register\("validateReleaseSigning"\)/);
    assert.match(androidGradle, /\["assembleRelease", "bundleRelease", "packageRelease"\]/);
    assert.match(androidGradle, /task\.dependsOn\("validateReleaseSigning"\)/);
    assert.match(androidGradle, /refuses the debug key alias/);
    assert.match(androidGradle, /refuses debug\.keystore/);
    assert.match(androidGradle, /certificate fingerprint mismatch/);
    // 唯一的 debug 出口：CI 显式开关 + 仓库内那份标准密钥 + 别名三者同时成立。
    assert.match(androidGradle, /AIDB_ALLOW_DEBUG_RELEASE_SIGNING/);
    assert.match(androidGradle, /def trackingDebugKeystore = allowDebugReleaseSigning/);
  });

  check('iOS Release uses distribution signing without a committed team', () => {
    assert.match(iosProject, /"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]" = "Apple Distribution"/);
    assert.match(iosProject, /CODE_SIGN_STYLE = Automatic/);
    assert.doesNotMatch(iosProject, /DEVELOPMENT_TEAM\s*=\s*"[A-Z0-9]/);
    assert.equal(plistString(infoPlist, 'CFBundleShortVersionString'), '$(MARKETING_VERSION)');
    assert.equal(plistString(infoPlist, 'CFBundleVersion'), '$(CURRENT_PROJECT_VERSION)');
    assert.equal(plistString(infoPlist, 'LSMinimumSystemVersion'), '16.4');
    assert.ok(iosProject.includes(`CURRENT_PROJECT_VERSION = ${app.ios.buildNumber};`));
    assert.ok(iosProject.includes(`MARKETING_VERSION = ${app.version};`));
  });

  check('iOS privacy manifest is declared and bundled', () => {
    assert.ok(existsSync(join(mobileRoot, 'ios/AiDBStudio/PrivacyInfo.xcprivacy')));
    assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    assert.match(privacy, /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
    assert.match(privacy, /<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    assert.match(privacy, /NSPrivacyAccessedAPICategoryDiskSpace/);
    assert.match(privacy, /E174\.1/);
    assert.match(privacy, /NSPrivacyAccessedAPICategoryFileTimestamp/);
    assert.match(privacy, /3B52\.1/);
    assert.match(iosProject, /F16A00022C00000100A1DB01 \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = F16A00012C00000100A1DB01/);
    assert.match(iosProject, /files = \([\s\S]*?F16A00022C00000100A1DB01 \/\* PrivacyInfo\.xcprivacy in Resources \*\//);
  });

  check('shared iOS scheme archives Release and has no stale test target', () => {
    assert.match(scheme, /<ArchiveAction[\s\S]*?buildConfiguration = "Release"/);
    assert.doesNotMatch(scheme, /AiDBStudioTests\.xctest|00E356ED1AD99517003FC87E/);
    assert.doesNotMatch(iosProject, /EXUpdates\.bundle/);
  });

  check('package commands invoke real native builds rather than web export', () => {
    const expected = {
      'build:android:debug': 'android-debug',
      'build:android:release': 'android-release',
      'build:ios:simulator': 'ios-simulator',
      'build:ios:archive': 'ios-archive',
      'check:release': 'scripts/check-release-config.mjs',
    };
    for (const [script, command] of Object.entries(expected)) {
      assert.ok(mobilePackage.scripts[script]?.includes(command), `missing native command ${script}`);
      assert.doesNotMatch(mobilePackage.scripts[script], /export:web/);
    }
    assert.match(nativeBuild, /:app:assembleDebug/);
    assert.match(nativeBuild, /:app:bundleRelease/);
    assert.match(nativeBuild, /pod', \['install'\]/);
    assert.match(nativeBuild, /'xcodebuild'/);
    assert.match(nativeBuild, /CODE_SIGNING_ALLOWED=NO/);
    assert.match(nativeBuild, /-allowProvisioningUpdates/);
  });

  console.log(`[release-config] ${checks.length} static release checks passed.`);
  console.log('[release-config] Credentials: EAS production/preview use remote credentials; local Android uses MYAPP_UPLOAD_*; local iOS uses automatic signing. Never commit credentials.json or signing material.');
  console.log('[release-config] Versions: EAS uses the remote build-version source; initialize it from the last store build with eas build:version:set when necessary.');
  console.warn('[release-config] Static validation is not a native build or store-readiness certification. Run build:android:release and build:ios:archive, or the corresponding EAS profiles.');
  if (!mobilePackage.dependencies['expo-updates']) {
    console.warn('[release-config] expo-updates is absent and native updates are disabled: channel "production" is a convention only, not active OTA.');
  }
} catch (error) {
  console.error(`[release-config] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
