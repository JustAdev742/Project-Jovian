@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /LD /O2 /fp:fast /arch:AVX2 flykernel.c /Fe:flykernel.dll
