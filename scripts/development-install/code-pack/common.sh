#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/../common.sh"
: "${DEV_PAIR_CODE_PACK_PACKET:?}" "${DEV_PAIR_CODE_PACK_PACKET_SHA256:?}" "${DEV_PAIR_CODE_PACK_LABEL:?}"
case "$DEV_PAIR_CODE_PACK_LABEL" in old|new) ;; *) exit 1 ;; esac
