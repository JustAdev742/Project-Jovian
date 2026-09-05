@echo off
REM Build and run the redaction test.
REM
REM Redact() is the only thing between a live bearer token and the diagnostics database, and it is
REM the one function here worth a standalone harness: Cobalt hooks the call that sets curl's URL,
REM so it sees `eg1~<jwt>` on every sign-out as a matter of course.
REM
REM It has already earned its keep. The first version matched `code=` anywhere, which redacted
REM `Gameserver exited (code=3221225477)` — the most useful host diagnostic in the project — into
REM `(code=<redacted>`. Reading the code did not catch that; running it did.
REM
REM Usage:  tests\build-and-run.cmd
setlocal
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (echo could not initialise the MSVC environment & exit /b 1)
pushd "%~dp0"
cl /nologo /EHsc /std:c++17 /W4 /I ".." test_redact.cpp "..\diagnostics.cpp" /Fe:"%~dp0test_redact.exe" /link kernel32.lib
if errorlevel 1 (echo BUILD FAILED & popd & exit /b 1)
REM Explicit path: cmd resolves a bare name against PATH first, and the build output is here.
"%~dp0test_redact.exe"
set RC=%ERRORLEVEL%
if not %RC%==0 goto :done

REM The emitter is shared verbatim with Project Reboot. If the copies drift the two components stop
REM speaking the same schema, and the dashboard silently stops being able to compare a client failure
REM with a host one.
set REBOOT=..\..\..\..\Project-Reboot-DLL\Project Reboot
if exist "%REBOOT%\diagnostics.cpp" (
  fc /b "..\diagnostics.cpp" "%REBOOT%\diagnostics.cpp" >nul || (echo DRIFT: diagnostics.cpp differs from the Reboot copy & set RC=1)
  fc /b "..\diagnostics.h"   "%REBOOT%\diagnostics.h"   >nul || (echo DRIFT: diagnostics.h differs from the Reboot copy & set RC=1)
  if %RC%==0 echo   ok   shared emitter matches the Reboot copy
) else (
  echo   note: Reboot copy not found at "%REBOOT%" - drift check skipped
)

:done
popd
exit /b %RC%
