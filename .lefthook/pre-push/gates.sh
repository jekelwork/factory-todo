#!/bin/sh
# Every pre-push gate, in scripts/pre-push.mjs, which says why this is a script (#41, docs/DECISIONS.md).
exec mise exec -- node scripts/pre-push.mjs "$@"
