#!/bin/bash
FILE="index.html"
cp "$FILE" "${FILE}.bak13"

# 1. Change title
sed -i 's|Overall ACH% Analysis|improvement rate RANK|g' "$FILE"

# 2. Hide prev-start/prev-end inputs (keep HTML but hide them)
sed -i '/id="prev-start"/s/class="/class="hidden /' "$FILE"
sed -i '/id="prev-end"/s/class="/class="hidden /' "$FILE"

# 3. Change "pp" to "%" in comparison display
sed -i '/wd.overall>=0/s/'\''+'\'')+wd.overall.toFixed(1)+'\''pp'\''/(wd.overall>=0?"":"")+wd.overall.toFixed(1)+"%"' "$FILE"
sed -i 's/(item.delta>0?'\''+'\'':'\'\'')+item.delta.toFixed(1)/item.delta>0?"+"+item.delta.toFixed(1)+"%":item.delta<0?item.delta.toFixed(1)+"%":"0.0%"/' "$FILE"

# 4. Add _lastMonthDates helper before renderPeriodComparison
# Find the exact insertion point - before renderPeriodComparison function
sed -i '/window.renderPeriodComparison = function()/i\        function _lastMonthDates(){ var n=new Date(),y=n.getFullYear(),m=n.getMonth(); if(m===0){m=12;y--} var d=new Date(y,m,0).getDate(),r=[]; for(var i=1;i<=d;i++){var ds=y+"-"+String(m).padStart(2,"0")+"-"+String(i).padStart(2,"0");r.push(ds)} return r; }' "$FILE"

# 5. Modify renderPeriodComparison to use _lastMonthDates instead of prev-start/prev-end
# Replace the function body's prev date logic
sed -i '/window.renderPeriodComparison = function(){/,/};$/{
    s/const ps=document.getElementById(.prev-start.).value;/const lmDates=_lastMonthDates();/
    s/const pe=document.getElementById(.prev-end.).value;// 
}' "$FILE"

echo "✅ Done patching"
