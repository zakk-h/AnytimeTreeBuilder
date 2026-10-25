#pragma once

#include <cerrno>
#include <cstdint>
#include <iostream>
#include <string>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#else
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace arborenum::live {
// The URL is generated from the bound loopback port, never passed to a shell.
inline bool open_local_browser(const std::string& url) {
#ifdef _WIN32
    const std::wstring wide(url.begin(), url.end());
    return reinterpret_cast<std::intptr_t>(ShellExecuteW(
        nullptr, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32;
#else
#ifdef __APPLE__
    const char* program = "/usr/bin/open";
#else
    const char* program = "xdg-open";
#endif
    char* arguments[] = {const_cast<char*>(program), const_cast<char*>(url.c_str()), nullptr};
    pid_t child;
    if (posix_spawnp(&child, program, nullptr, nullptr, arguments, environ) != 0) return false;
    // Reap the opener without holding up startup or application shutdown if a
    // browser chooses to keep its opener process alive for the whole window.
    std::thread([child] {
        int status;
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    }).detach();
    return true;
#endif
}
}
