#!/usr/bin/env bash


temp="$(mktemp)"

for license in licenses/*
do
    {
        echo "<pre class=\"license\" id=\"${license/licenses\//}\">"
        cat "${license}"
        echo "</pre>"
    } >> "${temp}"
done

sed "/The License texts -->/r${temp}" index.src.html > index.html

