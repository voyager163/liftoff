#define UNICODE
#define _UNICODE
#include <windows.h>
#include <wchar.h>
#include <stdio.h>

static BOOL WINAPI ignore_ctrl(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

static int fail(const wchar_t *message) {
  fwprintf(stderr, L"Liftoff launcher failed: %ls (Windows error %lu).\n", message, GetLastError());
  return 1;
}

static BOOL ordinary_path(const wchar_t *file, BOOL directory) {
  DWORD attributes = GetFileAttributesW(file);
  return attributes != INVALID_FILE_ATTRIBUTES &&
    !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
    !!(attributes & FILE_ATTRIBUTE_DIRECTORY) == !!directory;
}

static BOOL installed_root(wchar_t *root, size_t capacity) {
  wchar_t file[32768], selected[32768];
  if (!ordinary_path(root, TRUE)) return FALSE;
  if (swprintf_s(file, 32768, L"%ls\\current.txt", root) < 0) return FALSE;
  if (GetFileAttributesW(file) == INVALID_FILE_ATTRIBUTES) {
    DWORD error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return FALSE;
    if (swprintf_s(file, 32768, L"%ls\\native-install.json", root) < 0) return FALSE;
    if (GetFileAttributesW(file) != INVALID_FILE_ATTRIBUTES) return FALSE;
    error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return FALSE;
    if (swprintf_s(file, 32768, L"%ls\\bundle.json", root) < 0) return FALSE;
    return ordinary_path(file, FALSE);
  }
  if (!ordinary_path(file, FALSE)) return FALSE;
  HANDLE pointer = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (pointer == INVALID_HANDLE_VALUE) return FALSE;
  BY_HANDLE_FILE_INFORMATION information;
  char bytes[256];
  DWORD count = 0;
  BOOL read = GetFileInformationByHandle(pointer, &information) &&
    information.nNumberOfLinks == 1 &&
    !(information.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
    information.nFileSizeHigh == 0 && information.nFileSizeLow < sizeof(bytes) &&
    ReadFile(pointer, bytes, sizeof(bytes), &count, NULL) &&
    count == information.nFileSizeLow;
  CloseHandle(pointer);
  if (!read || count < 72 || bytes[count - 2] != '\r' || bytes[count - 1] != '\n') return FALSE;
  count -= 2;
  if (bytes[count - 65] != '-') return FALSE;
  for (DWORD i = 0; i < count; i++) {
    char c = bytes[i];
    if (i > count - 65) {
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return FALSE;
    } else if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
        (c >= 'a' && c <= 'z') || c == '.' || c == '-')) return FALSE;
    selected[i] = (wchar_t)c;
  }
  selected[count] = 0;
  if (selected[0] < L'0' || selected[0] > L'9' || wcsstr(selected, L"..")) return FALSE;
  if (swprintf_s(file, 32768, L"%ls\\versions", root) < 0 || !ordinary_path(file, TRUE)) return FALSE;
  if (swprintf_s(file, 32768, L"%ls\\versions\\%ls", root, selected) < 0 || !ordinary_path(file, TRUE)) return FALSE;
  if (swprintf_s(root, capacity, L"%ls", file) < 0) return FALSE;
  if (swprintf_s(file, 32768, L"%ls\\bundle.json", root) < 0 || !ordinary_path(file, FALSE)) return FALSE;
  return TRUE;
}

int wmain(void) {
  wchar_t module[32768], runtime[32768], script[32768], admission[32768];
  DWORD length = GetModuleFileNameW(NULL, module, 32768);
  if (!length || length >= 32768) return fail(L"cannot establish the installed launcher path");
  wchar_t *last = wcsrchr(module, L'\\');
  if (!last) return fail(L"the launcher has no installation directory");
  *last = 0;
  if (!ordinary_path(module, TRUE)) return fail(L"the launcher directory is unavailable or unsafe");
  last = wcsrchr(module, L'\\');
  if (!last) return fail(L"the launcher has no bundle root");
  *last = 0;
  if (!installed_root(module, 32768)) return fail(L"the exact installed version pointer is unavailable or unsafe");
  if (swprintf_s(runtime, 32768, L"%ls\\runtime\\node.exe", module) < 0 ||
      swprintf_s(script, 32768, L"%ls\\application\\dist\\cli.js", module) < 0 ||
      swprintf_s(admission, 32768, L"%ls\\installation\\host.mjs", module) < 0) return fail(L"installed paths exceed the launcher bound");
  if (!SetEnvironmentVariableW(L"NODE_OPTIONS", NULL) ||
      !SetEnvironmentVariableW(L"NODE_PATH", NULL)) return fail(L"cannot isolate private Node startup");
  const wchar_t *tail = GetCommandLineW();
  if (*tail == L'"') {
    tail++;
    while (*tail && *tail != L'"') tail++;
    if (*tail) tail++;
  } else {
    while (*tail && *tail != L' ' && *tail != L'\t') tail++;
  }
  if (!SetConsoleCtrlHandler(ignore_ctrl, TRUE)) return fail(L"cannot register console control handling");
  for (int phase = 0; phase < 2; phase++) {
    wchar_t command[32768];
    if (swprintf_s(command, 32768, L"\"%ls\" \"%ls\"%ls", runtime,
        phase == 0 ? admission : script, phase == 0 ? L"" : tail) < 0) return fail(L"command exceeds the Windows argument bound");
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(runtime, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) {
      fwprintf(stderr, L"Liftoff private runtime could not start (%lu).\n", GetLastError());
      return 1;
    }
    CloseHandle(child.hThread);
    DWORD wait = WaitForSingleObject(child.hProcess, INFINITE), code = 1;
    BOOL statusRead = wait == WAIT_OBJECT_0 && GetExitCodeProcess(child.hProcess, &code);
    CloseHandle(child.hProcess);
    if (!statusRead) return fail(L"private runtime exit could not be established");
    if (code != 0 || phase == 1) return (int)code;
  }
  return 1;
}
