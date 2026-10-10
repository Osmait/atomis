#!/bin/sh
# Container entrypoint: hand /data to the atomis user, then run as it.
#
# The server runs other people's code, so it never runs as root. Hosts like
# Railway mount volumes owned by root, though, which a non-root image cannot
# write; their documented workaround (RAILWAY_RUN_UID=0) would run the whole
# service, programs included, as root. Instead the image starts as root and
# only this script does anything with it: it takes ownership of what in
# /data is not already the atomis user's, then becomes that user for good.
set -eu

if [ "$(id -u)" = 0 ]; then
    mkdir -p /data
    # Only what is not ours yet, so a large volume is not re-walked on
    # every start.
    find /data -xdev ! -user atomis -exec chown atomis:atomis {} +
    export HOME=/home/atomis USER=atomis LOGNAME=atomis
    exec setpriv --reuid=atomis --regid=atomis --init-groups --inh-caps=-all \
        atomis-server "$@"
fi

exec atomis-server "$@"
