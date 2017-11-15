#!/usr/bin/env python2
import glob

for name in glob.glob("licenses/*.txt"):
    txt = open(name).read()
    print '<pre class="license" id="%s">' % name[:-4]
    print txt
    print '</pre>'
