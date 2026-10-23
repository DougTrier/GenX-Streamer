"""Pure/mock packaging contracts; never invokes Cargo, Gradle, ADB or an APK."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'src-tauri/scripts/build-android.ps1'
SHELL = shutil.which('pwsh') or shutil.which('powershell')


@unittest.skipUnless(SHELL, 'PowerShell required for script contract fixtures')
class AndroidDevelopmentPackagingTests(unittest.TestCase):
    def run_ps(self, body):
        with tempfile.TemporaryDirectory(prefix='GenX-packaging-contract-') as directory:
            fixture = Path(directory) / 'fixture.ps1'
            fixture.write_text("$ErrorActionPreference='Stop'\n" + body, encoding='utf-8')
            result = subprocess.run([SHELL, '-NoProfile', '-NonInteractive', '-File', str(fixture)],
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip()

    def functions(self):
        quoted = str(SCRIPT).replace("'", "''")
        return f"""$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('{quoted}',[ref]$tokens,[ref]$errors)
if($errors.Count){{throw 'parse failed'}}
$ast.FindAll({{param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]}},$true) | ForEach-Object {{Invoke-Expression $_.Extent.Text}}
"""

    def test_default_and_optimized_profiles_preserve_debug_contract(self):
        output = self.run_ps(self.functions() + "@(Get-TmgDevelopmentProfile 0;Get-TmgDevelopmentProfile 2)|ConvertTo-Json -Compress")
        profiles = json.loads(output)
        self.assertEqual([p['optimization'] for p in profiles], [0, 2])
        for profile in profiles:
            self.assertEqual(profile['profile'], 'dev')
            self.assertEqual(profile['gradle'], 'Debug')
            for flag in ['debugAssertions', 'overflowChecks', 'jniDebug']:
                self.assertIs(profile[flag], True)
            self.assertEqual(profile['debug'], 2)
            self.assertIs(profile['stripped'], False)
        source = SCRIPT.read_text()
        self.assertIn('[ValidateSet(0,2)][int]$Optimization = 0', source)
        self.assertIn('[switch]$CleanApkPackaging', source)
        self.assertNotIn('--release', source)
        self.run_ps(self.functions() + "try{Get-TmgDevelopmentProfile 1;throw 'unexpected'}catch{if($_.Exception.Message -ne 'Unsupported development optimization; packaging refused'){throw}}")

    def test_flag_projection_redacts_environment_paths_and_arbitrary_text(self):
        body = self.functions() + """
Get-TmgCompilerFlags 'Running SECRET=private https://private.example rustc C:/private.rs -C opt-level=2 -C debuginfo=2 -C debug-assertions=on -C overflow-checks=on' | ConvertTo-Json -Compress
Get-TmgCompilerFlags 'running: clang SECRET=private -O2 -gdwarf-4 -fPIC' | ConvertTo-Json -Compress
if($null -ne (Get-TmgCompilerFlags 'SECRET=private -O2')){throw 'noncompiler admitted'}
"""
        output = self.run_ps(body)
        self.assertNotIn('private', output)
        records = [json.loads(line) for line in output.splitlines()]
        self.assertEqual(records[0]['compiler'], 'rustc')
        self.assertIn('-C overflow-checks=on', records[0]['flags'])
        self.assertEqual(records[1]['flags'], ['-fPIC', '-gdwarf-4', '-O2'])

    def test_clean_missing_or_regular_build_only_and_file_refusal(self):
        with tempfile.TemporaryDirectory(prefix='GenX-clean-contract-') as directory:
            app = Path(directory) / 'app'
            app.mkdir()
            quoted = directory.replace("'", "''")
            output = self.run_ps(self.functions() + f"Assert-TmgCleanBuildPath '{quoted}'")
            self.assertEqual(Path(output), app / 'build')
            (app / 'build').write_text('not a directory')
            self.run_ps(self.functions() + f"try{{Assert-TmgCleanBuildPath '{quoted}';throw 'unexpected'}}catch{{if($_.Exception.Message -ne 'Android clean build path is not a directory'){{throw}}}}")

    @unittest.skipUnless(os.name == 'nt', 'Windows junction contract')
    def test_clean_refuses_junction_without_touching_external_file(self):
        with tempfile.TemporaryDirectory(prefix='GenX-clean-junction-') as directory:
            root = Path(directory)
            (root / 'android/app').mkdir(parents=True)
            (root / 'outside').mkdir()
            marker = root / 'outside/retained.txt'
            marker.write_text('retain')
            path = str(root / 'android').replace("'", "''")
            target = str(root / 'outside').replace("'", "''")
            self.run_ps(self.functions() + f"New-Item -ItemType Junction -Path '{path}/app/build' -Target '{target}' | Out-Null\ntry{{Assert-TmgCleanBuildPath '{path}';throw 'unexpected'}}catch{{if($_.Exception.Message -ne 'Android clean reparse path refused'){{throw}}}}")
            self.assertEqual(marker.read_text(), 'retain')

    def test_mock_native_failure_receipt_and_profile_environment_restored(self):
        with tempfile.TemporaryDirectory(prefix='GenX-mock-package-') as directory:
            root = Path(directory)
            script = root / 'src-tauri/scripts/build-android.ps1'
            script.parent.mkdir(parents=True)
            # Shadow commands in this child PowerShell only, with no subprocess build.
            source = SCRIPT.read_text().replace("$ErrorActionPreference = 'Stop'", """$ErrorActionPreference = 'Stop'
function rustup { $global:LASTEXITCODE=0; 'x86_64-linux-android' }
function cargo { if($env:CARGO_PROFILE_DEV_DEBUG -ne '2' -or $env:CARGO_PROFILE_DEV_DEBUG_ASSERTIONS -ne 'true' -or $env:CARGO_PROFILE_DEV_OVERFLOW_CHECKS -ne 'true' -or $env:CARGO_PROFILE_DEV_STRIP -ne 'none'){throw 'profile not applied'}; $global:LASTEXITCODE=7; 'Running SECRET=private rustc -C opt-level=2 -C debuginfo=2' }
""", 1)
            script.write_text(source)
            (script.parent / 'sync-launcher-icons.ps1').write_text('# fixture no-op')
            for name in ['src-tauri/gen/android/app', 'sdk/ndk/fixture/toolchains/llvm/prebuilt/windows-x86_64/bin', 'jdk/bin', 'dist']:
                (root / name).mkdir(parents=True, exist_ok=True)
            for name in ['sdk/ndk/fixture/toolchains/llvm/prebuilt/windows-x86_64/bin/x86_64-linux-android24-clang.cmd', 'sdk/ndk/fixture/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe', 'jdk/bin/java.exe', 'dist/index.html']:
                (root / name).write_text('fixture')
            q = lambda value: str(value).replace("'", "''")
            output = self.run_ps(f"""$env:CARGO_PROFILE_DEV_OPT_LEVEL='original'
try{{ & '{q(script)}' -SdkRoot '{q(root/'sdk')}' -JdkRoot '{q(root/'jdk')}' -NdkVersion fixture -UseExistingSharedBuild -Optimization 2; throw 'unexpected' }}
catch{{if($_.Exception.Message -ne 'Android native compilation failed; no APK packaging performed'){{throw}}}}
if($env:CARGO_PROFILE_DEV_OPT_LEVEL -ne 'original'){{throw 'profile leaked'}}
""")
            self.assertNotIn('private', output)
            receipt = json.loads(next(line.removeprefix('Android packaging failure ') for line in output.splitlines() if line.startswith('Android packaging failure ')))
            self.assertEqual(receipt, {'schemaVersion': 1, 'stage': 'native-build', 'optimization': 2, 'cleanApkPackaging': False, 'status': 'failed'})
            self.assertFalse((root / 'src-tauri/gen/android/app/build').exists())
            # A clean failure is terminal before assemble; native and historical
            # bytes remain untouched. Only a PowerShell mock runs, never Gradle.
            native = root / 'src-tauri/target/x86_64-linux-android/debug/libtmg_tv_lib.so'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'unstripped-fixture')
            historical = root / 'artifacts/retained.apk'
            historical.parent.mkdir()
            historical.write_bytes(b'historical-fixture')
            source = source.replace("$global:LASTEXITCODE=7", "$global:LASTEXITCODE=0")
            source = source.replace("& ./gradlew.bat ':app:clean' --console=plain", "$global:LASTEXITCODE=9")
            script.write_text(source)
            output = self.run_ps(f"""try{{ & '{q(script)}' -SdkRoot '{q(root/'sdk')}' -JdkRoot '{q(root/'jdk')}' -NdkVersion fixture -UseExistingSharedBuild -CleanApkPackaging; throw 'unexpected' }}
catch{{if($_.Exception.Message -ne 'Android Gradle clean failed; packaging refused'){{throw}}}}
""")
            receipt = json.loads(next(line.removeprefix('Android packaging failure ') for line in output.splitlines() if line.startswith('Android packaging failure ')))
            self.assertEqual(receipt['stage'], 'gradle-clean')
            self.assertIs(receipt['cleanApkPackaging'], True)
            self.assertEqual(native.read_bytes(), b'unstripped-fixture')
            self.assertEqual(historical.read_bytes(), b'historical-fixture')


if __name__ == '__main__':
    unittest.main()
