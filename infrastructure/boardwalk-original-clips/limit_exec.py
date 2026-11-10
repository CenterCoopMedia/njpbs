"""Apply a file-size ceiling without running Python hooks between fork and exec."""
import os
import resource
import sys

limit = int(sys.argv[1])
resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
os.execv(sys.argv[2], sys.argv[2:])
