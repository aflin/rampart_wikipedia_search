die() {
	echo $1
	exit 1
}

RP=`which rampart`;

if [ "$RP" == "" ]; then
	echo "Cannot find rampart executable in your path"
	exit 1;
fi

ls ./data/wikipedia_search/ 2>&1 1>/dev/null || die "could not find './data/wikipedia_search/' directory.  Has the db been build?"

$RP ./web_server_conf.js

