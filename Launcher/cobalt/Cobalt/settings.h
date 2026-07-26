#pragma once

enum class ECobaltUsage
{
	Private,
	Hybrid,
	// RecordingRequests // todo?
};

#define URL_PROTOCOL "http"
#define URL_HOST "127.0.0.1"
#define URL_PORT "3551"
// #define USE_MINHOOK // ONLY USE IF U INJECT LATE

// SHOW_WINDOWS_CONSOLE is off: instead of AllocConsole() opening a second window beside the game,
// Cobalt::Log::Init() redirects std::cout to the launcher's Logs tab and to
// %LOCALAPPDATA%\ProjectNova\Logs\cobalt.log. Every std::cout call in this project is unchanged.
// #define SHOW_WINDOWS_CONSOLE

// Where the log/status channel posts. Same backend as URL_HOST/URL_PORT above, in WinHttp's shapes.
#define COBALT_BACKEND_HOST_W   L"127.0.0.1"
#define COBALT_BACKEND_PORT_N   3551

constexpr static ECobaltUsage CobaltUsage = ECobaltUsage::Private;
constexpr bool bIsS13Epic = false; // S13 Hybrid Windows -> IOS fake