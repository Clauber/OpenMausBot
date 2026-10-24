// taskkill /T cannot find descendants once their routine parent has exited. The routine runs in a Job Object
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; its non-inheritable handle closes when Python exits, ending the rest.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
// https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw

/** Run as `python <bootstrap> <routine.py>` from the routine's scratch folder. Exits 70 without
 *  running the routine when the job cannot be set up. */
export const WINDOWS_JOB_BOOTSTRAP = String.raw`import ctypes
import runpy
import sys
from ctypes import wintypes

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _refuse(step):
    error = ctypes.get_last_error()
    sys.stderr.write("routine containment failed at %s: %s\n" % (step, ctypes.FormatError(error)))
    sys.stderr.flush()
    raise SystemExit(70)


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
_kernel32.CreateJobObjectW.restype = wintypes.HANDLE
_kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
_kernel32.SetInformationJobObject.restype = wintypes.BOOL
_kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
_kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
_kernel32.GetCurrentProcess.argtypes = ()
_kernel32.GetCurrentProcess.restype = wintypes.HANDLE

# The only handle to the job. Never closed here: closing it ends every process in the job,
# this one included, so it closes when Python exits.
_ROUTINE_JOB = _kernel32.CreateJobObjectW(None, None)
if not _ROUTINE_JOB:
    _refuse("CreateJobObjectW")
_limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
if not _kernel32.SetInformationJobObject(_ROUTINE_JOB, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                                         ctypes.byref(_limits), ctypes.sizeof(_limits)):
    _refuse("SetInformationJobObject")
if not _kernel32.AssignProcessToJobObject(_ROUTINE_JOB, _kernel32.GetCurrentProcess()):
    _refuse("AssignProcessToJobObject")

sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
