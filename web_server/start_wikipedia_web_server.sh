die() {
	echo $1
	exit 1
}

RP=`which rampart`;

if [ "$RP" == "" ]; then
	echo "Cannot find rampart executable in your path"
	exit 1;
fi

ls ./data/wikidb/ 2>&1 1>/dev/null || die "could not find './data/wikidb/' directory.  Has the db been build?"

$RP ./web_server_conf.js

