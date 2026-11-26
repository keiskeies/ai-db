import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(mobileRoot, path), 'utf8');
const app = JSON.parse(read('app.json')).expo;
const mobilePackage = JSON.parse(read('package.json'));
const eas = JSON.parse(read('eas.json'));
const androidRootGradle = read('android/build.gradle');
const androidSettings = read('android/settings.gradle');
const gradle = read('android/app/build.gradle');
const androidProperties = read('android/gradle.properties');
const gradleWrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
const podfile = read('ios/Podfile');
const podfileProperties = JSON.parse(read('ios/Podfile.properties.json'));
const appDelegate = read('ios/AiDBStudio/AppDelegate.swift');
const sceneDelegate = read('ios/AiDBStudio/SceneDelegate.swift');
const xcodeProject = read('ios/AiDBStudio.xcodeproj/project.pbxproj');
const infoPlist = read('ios/AiDBStudio/Info.plist');
const scheme = read('ios/AiDBStudio.xcodeproj/xcshareddata/xcschemes/AiDBStudio.xcscheme');
const privacy = read('ios/AiDBStudio/PrivacyInfo.xcprivacy');

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  'continue-on-error'?: boolean;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  uses?: string;
  'runs-on'?: string;
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const loadWorkflow = (name: string): Workflow => yaml.load(readFileSync(join(repoRoot, '.github/workflows', name), 'utf8')) as Workflow;
const releaseWorkflow = loadWorkflow('release.yml');
const ciWorkflow = loadWorkflow('ci.yml');
const publishWorkflow = loadWorkflow('publish-mcp.yml');
const releaseJobs = releaseWorkflow.jobs;
const workflowStep = (jobName: string, stepName: string): WorkflowStep => {
  const found = releaseJobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
  assert.ok(found, `missing ${jobName} step ${stepName}`);
  return found;
};
const workflowRun = (jobName: string, stepName: string): string => {
  const run = workflowStep(jobName, stepName).run;
  assert.ok(run, `${jobName} step ${stepName} must have a run block`);
  return run;
};
const needsOf = (job: WorkflowJob): string[] => typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];

function plistString(key: string) {
  return infoPlist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
}

test('mobile dependencies enforce the Expo SDK 58 / React Native 0.88 / React 19 baseline', () => {
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

test('Web pairing never evaluates the native-only Zeroconf module', () => {
  const pairScreen = read('src/screens/PairScreen.tsx');
  assert.match(pairScreen, /import type ZeroconfClass/);
  assert.doesNotMatch(pairScreen, /import Zeroconf/);
  assert.match(pairScreen, /if \(Platform\.OS === 'web'\) return \[\];[\s\S]*?require\('react-native-zeroconf'\)/);
});

test('Metro can resolve dependencies nested under the hoisted React DOM package', () => {
  const metro = read('metro.config.js');
  assert.match(metro, /disableHierarchicalLookup = true/);
  assert.match(metro, /path\.resolve\(workspaceRoot, 'node_modules', 'react-dom', 'node_modules'\)/);
});

test('Android native project uses the SDK 58 toolchain, New Architecture and Hermes', () => {
  assert.match(androidRootGradle, /apply plugin: "expo-root-project"/);
  assert.match(androidSettings, /id\("expo-autolinking-settings"\)/);
  assert.match(androidSettings, /expoAutolinking\.useExpoVersionCatalog\(\)/);
  assert.match(gradleWrapper, /gradle-9\.4\.1-bin\.zip/);
  assert.match(androidProperties, /^newArchEnabled=true$/m);
  assert.match(androidProperties, /^hermesEnabled=true$/m);
  assert.match(androidProperties, /^android\.enableMinifyInReleaseBuilds=true$/m);
  assert.match(gradle, /require\.resolve\('hermes-compiler\/package\.json'/);
  assert.match(gradle, /REACT_NATIVE_RELEASE_LEVEL/);
  assert.match(gradle, /expoLibs\.versions\.fresco/);
  assert.match(read('android/app/src/main/java/top/keiskei/aidb/MainApplication.kt'), /loadReactNative\(this\)/);
});

test('iOS native project uses the SDK 58 scene lifecycle and iOS 16.4', () => {
  assert.equal(podfileProperties.newArchEnabled, undefined);
  assert.match(podfile, /platform :ios, podfile_properties\['ios\.deploymentTarget'\] \|\| '16\.4'/);
  assert.match(podfile, /ENV\['RCT_USE_PREBUILT_RNCORE'\]/);
  assert.match(podfile, /ENV\['EXPO_USE_PRECOMPILED_MODULES'\] \|\|= '1'/);
  assert.doesNotMatch(podfile, /RCT_NEW_ARCH_ENABLED/);
  assert.match(podfile, /privacy_file_aggregation_enabled/);
  assert.match(podfile, /CODE_SIGNING_ALLOWED.*NO/);
  assert.match(appDelegate, /ExpoReactNativeFactoryProvider/);
  assert.match(appDelegate, /\.expo\/\.virtual-metro-entry/);
  assert.match(sceneDelegate, /class SceneDelegate: ExpoAppSceneDelegate/);
  assert.match(infoPlist, /<key>RCTNewArchEnabled<\/key>\s*<true\/>/);
  assert.match(infoPlist, /<key>UIApplicationSceneManifest<\/key>/);
  assert.match(xcodeProject, /objectVersion = 54;/);
  assert.match(xcodeProject, /AppDelegate\.swift in Sources/);
  assert.match(xcodeProject, /SceneDelegate\.swift in Sources/);
  assert.doesNotMatch(xcodeProject, /AppDelegate\.mm|main\.m in Sources|IPHONEOS_DEPLOYMENT_TARGET = 15\.1/);
  assert.equal(plistString('LSMinimumSystemVersion'), '16.4');
  assert.equal((xcodeProject.match(/IPHONEOS_DEPLOYMENT_TARGET = 16\.4;/g) ?? []).length, 4);
});

test('Android release signing never falls back to debug credentials', () => {
  const buildTypes = gradle.match(/buildTypes\s*\{([\s\S]*?)\n    \}/)?.[1] ?? '';
  const release = buildTypes.match(/release\s*\{([\s\S]*?)\n        \}/)?.[1] ?? '';
  assert.match(release, /signingConfig\s+signingConfigs\.release/);
  assert.doesNotMatch(release, /signingConfigs\.debug/);
  assert.match(gradle, /findProperty\(name\)\s*\?:\s*System\.getenv\(name\)/);
  for (const name of ['MYAPP_UPLOAD_STORE_FILE', 'MYAPP_UPLOAD_STORE_PASSWORD', 'MYAPP_UPLOAD_KEY_ALIAS', 'MYAPP_UPLOAD_KEY_PASSWORD', 'MYAPP_UPLOAD_CERT_SHA256']) {
    assert.ok(gradle.includes(name), `missing credential property ${name}`);
  }
});

test('Android release artifact tasks fail closed on missing or debug signing', () => {
  assert.match(gradle, /tasks\.register\("validateReleaseSigning"\)/);
  assert.match(gradle, /throw new GradleException\([\s\S]*?Missing: \$\{missing\.join\(', '\)\}/);
  assert.match(gradle, /Secret values are never logged/);
  assert.match(gradle, /signing\.keyAlias == "androiddebugkey"/);
  assert.match(gradle, /signing\.storeFile\.canonicalFile == file\("debug\.keystore"\)\.canonicalFile/);
  assert.match(gradle, /localReleaseCredentials && !releaseCertSha256/);
  assert.match(gradle, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(gradle, /certificate fingerprint mismatch/);
  assert.match(gradle, /\["assembleRelease", "bundleRelease", "packageRelease"\] as Set/);
  assert.match(gradle, /task\.dependsOn\("validateReleaseSigning"\)/);
});

test('EAS production is a store build with remote credentials and an explicit Node 22 runtime', () => {
  const production = eas.build.production;
  assert.equal(production.distribution, 'store');
  assert.equal(production.environment, 'production');
  assert.equal(production.credentialsSource, 'remote');
  assert.equal(production.channel, 'production');
  assert.equal(production.android.buildType, 'app-bundle');
  assert.equal(production.ios.scheme, 'AiDBStudio');
  assert.equal(production.ios.buildConfiguration, 'Release');
  assert.equal(production.ios.simulator, false);
  assert.equal(production.autoIncrement, true);
  assert.equal(eas.build.base.node, '22.23.3');
  assert.equal(eas.cli.appVersionSource, 'remote');
  assert.ok(!JSON.stringify(eas).includes('"developmentClient":true'));
});

test('native package commands use Gradle, CocoaPods, and xcodebuild', () => {
  const nativeBuild = read('scripts/native-build.mjs');
  const commands: Record<string, string> = {
    'build:android:debug': 'android-debug',
    'build:android:release': 'android-release',
    'build:ios:simulator': 'ios-simulator',
    'build:ios:archive': 'ios-archive',
  };
  for (const [name, command] of Object.entries(commands)) {
    assert.ok(mobilePackage.scripts[name]?.includes(command));
    assert.doesNotMatch(mobilePackage.scripts[name], /export:web/);
  }
  assert.match(nativeBuild, /:app:assembleDebug/);
  assert.match(nativeBuild, /:app:bundleRelease/);
  assert.match(nativeBuild, /pod', \['install'\]/);
  assert.match(nativeBuild, /'xcodebuild'/);
  assert.match(nativeBuild, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(nativeBuild, /-allowProvisioningUpdates/);
});

test('iOS version metadata and distribution signing are consistent', () => {
  assert.equal(app.version, mobilePackage.version);
  assert.match(gradle, new RegExp(`^\\s*versionCode\\s+${app.android.versionCode}\\s*$`, 'm'));
  assert.match(gradle, new RegExp(`^\\s*versionName\\s+"${app.version}"\\s*$`, 'm'));
  assert.equal(plistString('CFBundleShortVersionString'), '$(MARKETING_VERSION)');
  assert.equal(plistString('CFBundleVersion'), '$(CURRENT_PROJECT_VERSION)');
  assert.equal(plistString('LSMinimumSystemVersion'), '16.4');
  assert.ok(xcodeProject.includes(`MARKETING_VERSION = ${app.version};`));
  assert.ok(xcodeProject.includes(`CURRENT_PROJECT_VERSION = ${app.ios.buildNumber};`));
  assert.match(xcodeProject, /"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]" = "Apple Distribution"/);
  assert.match(xcodeProject, /CODE_SIGN_STYLE = Automatic/);
  assert.doesNotMatch(xcodeProject, /DEVELOPMENT_TEAM\s*=\s*"[A-Z0-9]/);
});

test('privacy manifest is truthful and registered in the Xcode resources phase', () => {
  assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  assert.match(privacy, /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
  assert.match(privacy, /<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryDiskSpace[\s\S]*?E174\.1/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryFileTimestamp[\s\S]*?3B52\.1/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults[\s\S]*?CA92\.1/);
  assert.ok(existsSync(join(mobileRoot, 'ios/AiDBStudio/PrivacyInfo.xcprivacy')));

  const buildFile = /F16A00022C00000100A1DB01 \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = F16A00012C00000100A1DB01/;
  assert.match(xcodeProject, buildFile);
  const resources = xcodeProject.match(/\/\* Begin PBXResourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXResourcesBuildPhase section \*\//)?.[1] ?? '';
  assert.match(resources, /F16A00022C00000100A1DB01/);
  assert.doesNotMatch(resources, /AiDBStudio-Bridging-Header\.h in Resources/);

  const buildFileSection = xcodeProject.match(/\/\* Begin PBXBuildFile section \*\/([\s\S]*?)\/\* End PBXBuildFile section \*\//)?.[1] ?? '';
  const fileReferenceSection = xcodeProject.match(/\/\* Begin PBXFileReference section \*\/([\s\S]*?)\/\* End PBXFileReference section \*\//)?.[1] ?? '';
  const buildFileIds = new Set([...buildFileSection.matchAll(/^\s*([A-F0-9]{24}) \/\*[^\n]+\*\/ = \{isa = PBXBuildFile;/gm)].map((match) => match[1]));
  const fileReferenceIds = new Set([...fileReferenceSection.matchAll(/^\s*([A-F0-9]{24}) \/\*[^\n]+\*\/ = \{isa = PBXFileReference;/gm)].map((match) => match[1]));
  for (const match of buildFileSection.matchAll(/isa = PBXBuildFile; fileRef = ([A-F0-9]{24})/g)) {
    assert.ok(fileReferenceIds.has(match[1]), `PBXBuildFile references missing file ${match[1]}`);
  }
  const resourceFiles = resources.match(/files = \(([\s\S]*?)\);/)?.[1] ?? '';
  for (const match of resourceFiles.matchAll(/^\s*([A-F0-9]{24}) \/\*/gm)) {
    assert.ok(buildFileIds.has(match[1]), `Resources references missing build file ${match[1]}`);
  }
});

test('shared iOS scheme archives Release without a stale test target', () => {
  assert.match(scheme, /<ArchiveAction[\s\S]*?buildConfiguration = "Release"/);
  assert.doesNotMatch(scheme, /AiDBStudioTests\.xctest|00E356ED1AD99517003FC87E/);
  assert.doesNotMatch(xcodeProject, /EXUpdates\.bundle/);
});

test('signing material conventions exclude local credential files', () => {
  const androidIgnore = read('android/.gitignore');
  const iosIgnore = read('ios/.gitignore');
  for (const pattern of ['*.keystore', '*.jks', 'credentials.json']) assert.ok(androidIgnore.includes(pattern));
  for (const pattern of ['*.p12', '*.mobileprovision', 'credentials.json']) assert.ok(iosIgnore.includes(pattern));
  assert.match(read('android/gradle.properties'), /EAS production uses credentialsSource=remote/);
});

test('release configuration checker passes and discloses its limits', () => {
  const result = spawnSync(process.execPath, [join(mobileRoot, 'scripts/check-release-config.mjs')], {
    cwd: mobileRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /static release checks passed/);
  assert.match(result.stderr, /not a native build or store-readiness certification/);
  assert.doesNotMatch(result.stderr, /Expo SDK 52 is legacy/);
  assert.match(result.stderr, /not active OTA/);
});

test('release source and reusable quality gate preserve tag/version/commit identity', () => {
  const source = releaseJobs.source;
  const quality = releaseJobs.quality;
  assert.ok(source && quality);
  assert.equal(source.outputs?.tag, '${{ steps.source.outputs.tag }}');
  assert.equal(source.outputs?.sha, '${{ steps.source.outputs.sha }}');
  const checkout = source.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.with?.ref, '${{ inputs.tag || github.ref }}');
  assert.equal(checkout?.with?.['persist-credentials'], false);

  const sourceRun = workflowRun('source', 'Validate tag, version and dispatch source');
  assert.match(sourceRun, /require\('\.\/package\.json'\)\.version/);
  assert.match(sourceRun, /require\('\.\/apps\/mobile\/package\.json'\)\.version/);
  assert.match(sourceRun, /\[ "\$\{\{ github\.event_name \}\}" = "workflow_dispatch" \]/);
  assert.match(sourceRun, /\[ "\$tested" != "\$GITHUB_SHA" \]/);
  assert.match(sourceRun, /echo "sha=\$tested" >> "\$GITHUB_OUTPUT"/);

  assert.ok(needsOf(quality).includes('source'));
  assert.equal(quality.uses, './.github/workflows/ci.yml');
  assert.equal(quality.with?.ref, '${{ needs.source.outputs.sha }}');
  for (const jobName of ['desktop', 'android', 'ios']) {
    const buildCheckout = releaseJobs[jobName]?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(buildCheckout?.with?.ref, '${{ needs.quality.outputs.sha }}', `${jobName} must build the tested commit`);
    assert.equal(buildCheckout?.with?.['persist-credentials'], false);
  }
});

test('secret-consuming native jobs use protected environments without write permissions', () => {
  assert.deepEqual(releaseWorkflow.permissions, { contents: 'read' });
  for (const jobName of ['desktop', 'android', 'ios']) {
    const job = releaseJobs[jobName];
    assert.ok(job);
    assert.equal(job.environment, 'release', `${jobName} must use the protected release environment`);
    assert.deepEqual(job.permissions, { contents: 'read' }, `${jobName} must not receive write permissions`);
    assert.ok(!Object.values(job.permissions ?? {}).includes('write'));
  }
  assert.ok(!Object.values(releaseJobs.source?.permissions ?? releaseWorkflow.permissions ?? {}).includes('write'));
  assert.equal(releaseJobs.release?.environment, 'release');
  assert.deepEqual(releaseJobs.release?.permissions, { contents: 'write' });
  assert.deepEqual(ciWorkflow.jobs.quality?.permissions, { contents: 'read' });
});

test('desktop keeps native signature and Linux policy checks but does not attest in the build job', () => {
  const steps = releaseJobs.desktop?.steps ?? [];
  assert.ok(!steps.some((step) => step.uses?.startsWith('actions/attest-build-provenance@')));
  assert.ok(!steps.some((step) => /attestation subjects/i.test(step.name ?? '')));
  const desktopText = steps.map((step) => step.run ?? '').join('\n');
  assert.match(desktopText, /Get-AuthenticodeSignature/);
  assert.match(desktopText, /codesign --verify --deep --strict/);
  assert.match(desktopText, /Authority=Developer ID Application:/);
  assert.match(desktopText, /flags=0x10000\(runtime\)/);
  assert.match(desktopText, /xcrun stapler validate/);
  assert.match(desktopText, /Linux artifacts are intentionally not platform-code-signed/);
  assert.match(desktopText, /signing-\$\{platform\}\.json/);
  assert.match(desktopText, /SHA256SUMS-\$\{platform\}/);
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload?.with?.['if-no-files-found'], 'error');
  assert.match(String(upload?.with?.path), /signing-\*\.json/);
  assert.match(String(upload?.with?.path), /SHA256SUMS-\*/);
});

test('Android release credentials fail closed and the staged APK fingerprint is verified', () => {
  const guard = workflowStep('android', 'Require and stage Android signing credentials');
  const secrets = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'ANDROID_CERT_SHA256'];
  for (const name of secrets) {
    assert.equal(guard.env?.[name], '${{ secrets.' + name + ' }}');
    assert.ok(workflowRun('android', 'Require and stage Android signing credentials').includes(`: "\${${name}:?${name} secret is required}"`));
  }
  const guardRun = guard.run ?? '';
  assert.match(guardRun, /base64 --decode > "\$keystore"/);
  assert.match(guardRun, /chmod 600 "\$keystore"/);
  assert.match(guardRun, /MYAPP_UPLOAD_STORE_FILE=\$keystore/);
  assert.match(guardRun, /MYAPP_UPLOAD_STORE_PASSWORD=\$ANDROID_KEYSTORE_PASSWORD/);
  assert.match(guardRun, /MYAPP_UPLOAD_KEY_ALIAS=\$ANDROID_KEY_ALIAS/);
  assert.match(guardRun, /MYAPP_UPLOAD_KEY_PASSWORD=\$ANDROID_KEY_PASSWORD/);
  assert.match(guardRun, /MYAPP_UPLOAD_CERT_SHA256=\$cert/);
  assert.match(guardRun, />> "\$GITHUB_ENV"/);
  assert.match(guardRun, /tr -d '\[:space:\]:'/);
  assert.match(guardRun, /ANDROID_KEY_ALIAS" = "androiddebugkey"/);
  assert.doesNotMatch(guardRun, /set\s+-x/);
  assert.doesNotMatch(guardRun, /\becho\b[^\n]*(?:PASSWORD|KEYSTORE_BASE64)/i);

  assert.equal(workflowStep('android', 'Build release APK').run, './gradlew assembleRelease --no-daemon');
  const verifyRun = workflowRun('android', 'Verify and stage APK');
  assert.match(verifyRun, /apksigner" verify --verbose --print-certs/);
  assert.match(verifyRun, /certificate SHA-256 digest:/);
  assert.match(verifyRun, /signer_count" -ne 1/);
  assert.match(verifyRun, /\[ "\$actual" != "\$expected" \]/);
  assert.match(verifyRun, /application-debuggable/);
  assert.match(verifyRun, /certificateSha256/);
  assert.match(verifyRun, /signatureVerified: true/);
  assert.match(verifyRun, /productionReady: true/);
  assert.doesNotMatch(verifyRun, /signing: 'debug'|productionReady: false/);
  const upload = releaseJobs.android?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload?.with?.name, 'aidb-android');
  assert.equal(upload?.if, undefined);
  assert.equal(upload?.with?.['if-no-files-found'], 'error');
  assert.match(String(upload?.with?.path), /SHA256SUMS-android/);
  assert.ok(!releaseJobs.android?.steps?.some((step) => step.uses?.startsWith('actions/attest-build-provenance@')));
});

test('iOS EAS production artifacts fail closed and receive independent macOS signature verification', () => {
  const ios = releaseJobs.ios;
  assert.ok(ios);
  assert.equal(ios['runs-on'], 'macos-latest');
  assert.equal(ios.environment, 'release');
  assert.deepEqual(ios.permissions, { contents: 'read' });
  assert.equal(ios.env?.EXPO_TOKEN, undefined);
  assert.equal(workflowStep('ios', 'Check EAS configuration').env?.EXPO_TOKEN, '${{ secrets.EXPO_TOKEN }}');
  assert.equal(workflowStep('ios', 'Trigger EAS production build').env?.EXPO_TOKEN, '${{ secrets.EXPO_TOKEN }}');
  const guardRun = workflowRun('ios', 'Check EAS configuration');
  assert.match(guardRun, /EXPO_TOKEN secret is required/);
  assert.match(guardRun, /non-placeholder UUID/);
  assert.match(guardRun, /00000000-0000-0000-0000-000000000000/);
  assert.doesNotMatch(guardRun, /warning|skipped|ok=0/);
  assert.ok(!ios.steps?.some((step) => step.if || step['continue-on-error']));

  const buildRun = workflowRun('ios', 'Trigger EAS production build');
  assert.match(buildRun, /--profile production/);
  assert.doesNotMatch(buildRun, /--profile preview/);
  assert.match(buildRun, /status !== 'FINISHED'/);
  assert.match(buildRun, /url\.protocol !== 'https:'/);
  const verifyRun = workflowRun('ios', 'Download, inspect and stage IPA');
  assert.match(verifyRun, /curl --fail/);
  assert.match(verifyRun, /--proto '=https'/);
  assert.match(verifyRun, /--proto-redir '=https'/);
  assert.match(verifyRun, /unzip -tq/);
  assert.match(verifyRun, /unsafe path in IPA/);
  assert.match(verifyRun, /codesign --verify --deep --strict/);
  assert.match(verifyRun, /Authority=Apple Distribution:/);
  assert.match(verifyRun, /flags=0x10000\(runtime\)/);
  assert.match(verifyRun, /security cms -D/);
  assert.match(verifyRun, /TeamIdentifier:0/);
  assert.match(verifyRun, /Entitlements:application-identifier/);
  assert.match(verifyRun, /ApplicationIdentifier:0/);
  assert.match(verifyRun, /ProvisionedDevices/);
  assert.match(verifyRun, /Print :CFBundleIdentifier/);
  assert.match(verifyRun, /Print :CFBundleShortVersionString/);
  assert.match(verifyRun, /Print :CFBundleVersion/);
  assert.match(verifyRun, /signatureVerified: true/);
  assert.match(verifyRun, /productionReady: true/);
  assert.match(verifyRun, /provisioningVerified: true/);
  assert.doesNotMatch(verifyRun, /signatureVerified: false|productionReady: false/);
  const upload = ios.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload?.with?.name, 'aidb-ios');
  assert.equal(upload?.if, undefined);
  assert.equal(upload?.with?.['if-no-files-found'], 'error');
  assert.match(String(upload?.with?.path), /dist-mobile\/\*\.ipa/);
  assert.match(String(upload?.with?.path), /SHA256SUMS-ios/);
  assert.ok(!ios.steps?.some((step) => step.uses?.startsWith('actions/attest-build-provenance@')));
});

test('release and reusable CI attestations download artifacts without checking out or executing code', () => {
  const attest = releaseJobs.attest;
  assert.ok(attest);
  assert.deepEqual(new Set(needsOf(attest)), new Set(['desktop', 'android', 'ios']));
  assert.deepEqual(attest.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.equal(attest.steps?.length, 2);
  assert.ok(!attest.steps?.some((step) => step.run || step.uses?.startsWith('actions/checkout@') || step.uses?.startsWith('./')));
  const download = attest.steps?.[0];
  assert.ok(download?.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with?.pattern, 'aidb-*');
  assert.equal(download.with?.['merge-multiple'], true);
  const provenance = attest.steps?.[1];
  assert.ok(provenance?.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(provenance.with?.['subject-path'], 'dist-release/*');

  const ciAttest = ciWorkflow.jobs.attest;
  assert.ok(ciAttest);
  assert.deepEqual(ciAttest.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.ok(!ciAttest.steps?.some((step) => step.run || step.uses?.startsWith('actions/checkout@') || step.uses?.startsWith('./')));
  assert.equal(ciAttest.steps?.[0]?.with?.name, 'aidb-sbom');
  assert.equal(ciAttest.steps?.[1]?.with?.['subject-path'], 'dist/sbom.cdx.json');
});

test('MCP trusted publishing isolates repository code from the OIDC-enabled publish job', () => {
  const packageJob = publishWorkflow.jobs.package;
  const publish = publishWorkflow.jobs.publish;
  assert.ok(packageJob && publish);
  assert.deepEqual(needsOf(packageJob), ['quality']);
  assert.equal(packageJob.outputs?.sha, '${{ needs.quality.outputs.sha }}');
  assert.deepEqual(packageJob.permissions, { contents: 'read' });
  assert.deepEqual(needsOf(publish), ['package']);
  assert.equal(publish.environment, 'release');
  assert.deepEqual(publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(publish.steps?.[0]?.with?.ref, '${{ needs.package.outputs.sha }}');

  const packageRuns = (packageJob.steps ?? []).map((step) => step.run ?? '').join('\n');
  assert.match(packageRuns, /npm pack --dry-run --json/);
  assert.match(packageRuns, /tarball content mismatch/);
  assert.match(packageRuns, /sha256sum "\$name" > SHA256SUMS/);
  assert.ok(packageJob.steps?.some((step) => step.uses?.startsWith('actions/upload-artifact@')));

  const publishRuns = (publish.steps ?? []).map((step) => step.run ?? '').join('\n');
  assert.doesNotMatch(publishRuns, /npm (?:ci|install|pack)\b/);
  assert.match(publishRuns, /sha256sum -c SHA256SUMS/);
  assert.match(publishRuns, /npm publish "\$MCP_TARBALL" --ignore-scripts/);
  assert.ok(publish.steps?.some((step) => step.uses?.startsWith('actions/download-artifact@')));
});

test('draft release staging requires verified native assets, iOS checksums and truthful notes', () => {
  const release = releaseJobs.release;
  assert.ok(release);
  assert.deepEqual(new Set(needsOf(release)), new Set(['quality', 'desktop', 'android', 'ios', 'attest']));
  const validationRun = workflowRun('release', 'Verify SBOM, signing manifests and checksums');
  assert.match(validationRun, /android\.signatureVerified !== true/);
  assert.match(validationRun, /android\.productionReady !== true/);
  assert.match(validationRun, /certificateSha256/);
  assert.match(validationRun, /\^\[0-9A-F\]\{64\}\$/);
  assert.match(validationRun, /ios\.signatureVerified !== true/);
  assert.match(validationRun, /ios\.signing !== 'Apple Distribution'/);
  assert.match(validationRun, /ios\.provisioningVerified !== true/);
  assert.match(validationRun, /requires both Android APK and iOS IPA artifacts/);
  assert.match(validationRun, /for platform in windows macos linux android ios;/);
  assert.doesNotMatch(validationRun, /if \[ -f dist-release\/SHA256SUMS-ios/);

  const notesRun = workflowRun('release', 'Generate release notes');
  assert.match(notesRun, /protected production upload key/);
  assert.match(notesRun, /independently verified on macOS/);
  assert.match(notesRun, /EAS production\/store IPA/);
  assert.doesNotMatch(notesRun, /debug-signed|signature was not independently verified|iOS was skipped/);
  const draft = workflowStep('release', 'Create draft release');
  assert.equal(draft.with?.draft, true);
  assert.equal(draft.with?.target_commitish, '${{ needs.quality.outputs.sha }}');
  assert.match(String(draft.with?.files), /dist-release\/\*\.ipa/);
  assert.match(String(draft.with?.files), /dist-release\/SHA256SUMS-\*/);
});
