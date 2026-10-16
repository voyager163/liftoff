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

int wmain(void) {
  wchar_t module[32768], runtime[32768], script[32768], admission[32768];
  DWORD length = GetModuleFileNameW(NULL, module, 32768);
  if (!length || length >= 32768) return fail(L"cannot establish the installed launcher path");
  wchar_t *last = wcsrchr(module, L'\\');
  if (!last) return fail(L"the launcher has no installation directory");
  *last = 0;
  last = wcsrchr(module, L'\\');
  if (!last) return fail(L"the launcher has no bundle root");
  *last = 0;
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
