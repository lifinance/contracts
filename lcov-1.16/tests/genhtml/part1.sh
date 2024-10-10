#!/usr/bin/env bash
#
# Create HTML output for info files containing partial coverage rates
#

OUTDIR="out_part1"
STDOUT="part1_stdout.log"
STDERR="part1_stderr.log"

rm -rf "${OUTDIR}"

# Run genhtml
$GENHTML $PART1INFO -o ${OUTDIR} >${STDOUT} 2>${STDERR}
RC=$?

echo "STDOUT_START"
cat ${STDOUT}
echo "STDOUT_STOP"

echo "STDERR_START"
cat ${STDERR}
echo "STDERR_STOP"

# Check exit code
if [[ $RC -ne 0 ]] ; then
	echo "Error: Non-zero genhtml exit code $RC"
	exit 1
fi

# Output must not contain warnings
if [[ -s ${STDERR} ]] ; then
	echo "Error: Output on stderr.log:"
	cat ${STDERR}
	exit 1
fi

# Output must indicate correct coverage rates
echo "Checking coverage rates in stdout"
check_counts "${PART1COUNTS}" "${STDOUT}" || exit 1

# Check output directory
if [[ ! -d "$OUTDIR" ]] ; then
	echo "Error: Output directory was not created"
	exit 1
fi

# Check output files
NUM_HTML_FILES=$(find ${OUTDIR} -name \*.html | wc -l)

if [[ "$NUM_HTML_FILES" -eq 0 ]] ; then
	echo "Error: No HTML file was generated"
	exit 1
fi

# Success
exit 0
