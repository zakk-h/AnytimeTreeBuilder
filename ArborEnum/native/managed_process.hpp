#pragma once

#include <algorithm>
#include <stdexcept>

#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace arborenum::live {
// A pipe owned by the desktop parent is also a lifetime lease. EOF covers both
// an ordinary window close and an unexpected parent crash, without a public
// HTTP shutdown endpoint or a platform-dependent process termination signal.
inline void require_owner_pipe() {
#ifdef _WIN32
    if (GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE)
#else
    struct stat info{};
    if (fstat(STDIN_FILENO, &info) != 0 || (!S_ISFIFO(info.st_mode) && !S_ISSOCK(info.st_mode)))
#endif
        throw std::invalid_argument("--managed requires a parent-owned stdin pipe");
}

inline bool owner_pipe_closed() {
    char discard[64];
#ifdef _WIN32
    const auto input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) return true;
    if (!available) return false;
    DWORD read = 0;
    return !ReadFile(input, discard, (std::min)(available, DWORD(sizeof discard)), &read, nullptr) || read == 0;
#else
    pollfd input{STDIN_FILENO, POLLIN, 0};
    const int result = poll(&input, 1, 0);
    if (result < 0) return errno != EINTR;
    if (!result) return false;
    if (input.revents & (POLLERR | POLLNVAL)) return true;
    if (input.revents & (POLLIN | POLLHUP)) {
        const auto count = read(STDIN_FILENO, discard, sizeof discard);
        return count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN);
    }
    return false;
#endif
}
}
