(function(){
        const api = window.sqdipAdv || (window.sqdipAdv = {});
        // ================= 1. 核心架构与云端引擎 =================
        const DB_KEY = 'mbs_sqdip_v4_cloud_fix';
        // ★ 使用全局 CLIENT_ID：确保与主脚本块一致，防止云端同步回环
        window.CLIENT_ID = window.CLIENT_ID || Math.random().toString(36).substring(2, 10);
        const CLIENT_ID = window.CLIENT_ID;
        // ★ SQDIP 看板使用独立的云端记录ID，不与主脚本冲突
        const CLOUD_RECORD_ID = 'sqdip_adv_board_pro'; 
        let realtimeChannel = null;
        let isFirebaseReadySQDIP = false;
        let localSaveTimeout = null;
        let cloudSaveTimeout = null;
        let db = {}; 
        let currentMonth = '';
        let currentWs = 'PRO2';
        let currentMetric = 'S';
        let chartObj = null;
        let macroChartObj = null;
        
        // 监听 Firebase 就绪事件
        window.addEventListener('firebaseReady', function() {
            isFirebaseReadySQDIP = true;
            updateCloudStatus();
        });
        // ★ 补偿：事件可能已在之前触发, 用setTimeout避免TDZ冲突
        if (window.isFirebaseReady) {
            setTimeout(function() {
                isFirebaseReadySQDIP = true;
                updateCloudStatus();
            }, 0);
        }
        
        function updateCloudStatus() {
            const badge = window.safeDOM.get("sqdip-adv-cloud-status"); if (!badge) return;
            if (isFirebaseReadySQDIP) {
                badge.innerHTML = `<i class="fa-solid fa-cloud" style="color:var(--success);"></i> 云端实时协同中`;
                badge.style.color = 'var(--success)';
            } else {
                badge.innerHTML = `<i class="fa-solid fa-hard-drive"></i> 本地单机模式`;
                badge.style.color = 'var(--text-muted)';
            }
        }
        
        // ★ 重命名为 triggerAutoSaveSQDIP，防止覆盖主脚本块的 triggerAutoSave
        async function triggerAutoSaveSQDIP() {
            // ★ 立即写入 localStorage（页面刷新也丢不了数据）
            try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
            // 更新保存状态指示器
            var _si = document.getElementById('save-indicator-text');
            if(_si) { _si.innerText = '已保存 at ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
            // 备用 debounce
            clearTimeout(localSaveTimeout);
            localSaveTimeout = setTimeout(function(){
                try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
            }, 500);
            // Firebase 云端同步
            if (isFirebaseReadySQDIP && window.firebaseDatabase) {
                clearTimeout(cloudSaveTimeout);
                cloudSaveTimeout = setTimeout(async function(){
                    try {
                        const sqdipRef = window.firebaseRef(window.firebaseDatabase, 'sqdip_board');
                        await window.firebaseSet(sqdipRef, { db: db, clientId: CLIENT_ID, updatedAt: Date.now() });
                    } catch(e) { console.error('Firebase sync failed:', e); }
                }, 2000);
            }
        }
        async function silentFetchCloudRealtime() {
            try {
                if (!isFirebaseReadySQDIP || !window.firebaseDatabase) return;
                const sqdipRef = window.firebaseRef(window.firebaseDatabase, 'sqdip_board');
                const snapshot = await window.firebaseGet(sqdipRef);
                const data = snapshot.val();
                if(data && data.db) {
                    // ★ 关键修复：合并云端数据，不要直接替换 db 引用
                    var cloudData = data.db;
                    // 合并 prod 数据（只合并不同日期的数据，保留本地已有数据的差异）
                    Object.keys(cloudData.prod||{}).forEach(function(d) {
                        if(!db.prod[d]) db.prod[d] = cloudData.prod[d];
                        else {
                            // 深度合并：对于已有日期，不覆盖本地数据（本地优先）
                            ['PRO1','PRO2','PRO3','PRO4'].forEach(function(ws) {
                                if(!db.prod[d][ws]) db.prod[d][ws] = cloudData.prod[d][ws];
                            });
                            // 特别处理 PRO2.lines: 保持本地shifts
                            if(cloudData.prod[d].PRO2 && cloudData.prod[d].PRO2.lines && db.prod[d].PRO2) {
                                Object.keys(cloudData.prod[d].PRO2.lines).forEach(function(ln) {
                                    if(!db.prod[d].PRO2.lines[ln]) db.prod[d].PRO2.lines[ln] = cloudData.prod[d].PRO2.lines[ln];
                                });
                            }
                        }
                    });
                    // 合并其他数据
                    ['dm','prodReport','dLinesConfig','problems','loss','sysDetail','memo'].forEach(function(k) {
                        if(cloudData[k] && !db[k]) {
                            db[k] = cloudData[k];
                        } else if(cloudData[k] && typeof cloudData[k] === 'object' && !Array.isArray(cloudData[k])) {
                            Object.keys(cloudData[k]).forEach(function(dk) {
                                if(!db[k][dk]) db[k][dk] = cloudData[k][dk];
                            });
                        } else if(cloudData[k] && Array.isArray(cloudData[k]) && cloudData[k].length > 0) {
                            // ★ 云端决定条目集合（cloud-authoritative），字段级合并保留本地编辑
                            // ★ 删除能传播：云端没有的条目→本地也不会保留
                            if(!db[k]) db[k] = [];
                            var _localArr = db[k];
                            var _cloudArr = cloudData[k];
                            var _localMap = {};
                            var _cloudMap = {};
                            _localArr.forEach(function(item) { if(item.id != null) _localMap[String(item.id)] = item; });
                            _cloudArr.forEach(function(item) { if(item.id != null) _cloudMap[String(item.id)] = item; });
                            var _newArr = [];
                            // 遍历云端条目（决定存在性），有本地匹配则字段级合并
                            _cloudArr.forEach(function(cloudItem) {
                                var cid = String(cloudItem.id);
                                var localItem = _localMap[cid];
                                if(localItem) {
                                    var merged = {};
                                    Object.keys(cloudItem).forEach(function(kk) { merged[kk] = cloudItem[kk]; });
                                    Object.keys(localItem).forEach(function(kk) {
                                        if(cloudItem[kk] === undefined && localItem[kk] !== undefined) {
                                            merged[kk] = localItem[kk];
                                        }
                                    });
                                    _newArr.push(merged);
                                } else {
                                    _newArr.push(cloudItem);
                                }
                            });
                            db[k] = _newArr;
                        }
                    });
                    console.log('[silentFetchCloudRealtime] merged cloud data successfully');
                    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
                    // ★ 修复：检查用户是否正在输入，防止数据回滚
                    if (!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
                        refreshAllUI();
                    }
                }
            } catch(e) {
                console.warn('[silentFetchCloudRealtime] failed:', e);
            }
        }
        // ================= 2. 7x7 矩阵 31天字母完美布局 =================
        const LETTER_SHAPES = {
            'S': [0,1,2,3,4,5,6, 7,8, 14,15, 21,22,23,24,25,26,27, 33,34, 40,41, 42,43,44,45,46,47,48, 9, 39],
            'Q': [1,2,3,4,5, 7,8,12,13, 14,15,19,20, 21,22,26,27, 28,29,33,34, 35,36,40,41, 43,44,45,46,47,48],
            'D': [0,1,2,3,4, 7,8,12,13, 14,15,19,20, 21,22,26,27, 28,29,33,34, 35,36,40,41, 42,43,44,45,46, 5],
            'I': [0,1,2,3,4,5,6, 9,10,11, 16,17,18, 23,24,25, 30,31,32, 37,38,39, 42,43,44,45,46,47,48, 8, 12],
            'P': [0,1,2,3,4,5,6, 7,8,12,13, 14,15,19,20, 21,22,23,24,25,26,27, 28,29, 35,36, 42,43, 30, 37, 44]
        };
        const CONFIG = {
            'S': { title: 'Safety 安全', sub: '0工伤，隐患排查100%', rule: '隐患数 <strong>≤ 0</strong> 为 🟩 OK。', unit: '项', tgt: 0 },
            'Q': { title: 'Quality 质量', sub: 'FQC 直通率达标', rule: 'FQC直通率 <strong>≥ 98.5</strong> 为 🟩 OK。', unit: '%', tgt: 98.5 },
            'D': { title: 'Delivery 交付', sub: '日计划达成率100%', rule: '欠产套数 <strong>≤ 0</strong> 为 🟩 OK。', unit: '套', tgt: 0 },
            'I': { title: 'Inventory 库存', sub: '在制品控制红线', rule: 'WIP套数 <strong>≤ 1500</strong> 为 🟩 OK。', unit: '套', tgt: 1500 },
            'P': { title: 'Productivity 效率', sub: 'UPPH 人均产出达标', rule: 'UPPH <strong>≥ 23.5</strong> 为 🟩 OK。', unit: '台/H', tgt: 23.5 }
        };
        function getDaysInMonth(yearMonth) {
            let [y, m] = yearMonth.split('-');
            return new Date(y, m, 0).getDate();
        }
        function changeWs() {
            currentWs = document.getElementById('sqdip-adv-ws-selector').value;
            changeMonth();
        }
        function changeMonth() {
            currentMonth = document.getElementById('sqdip-adv-month-selector').value;
            document.getElementById('sqdip-adv-sc-month').innerText = currentMonth;
            if(!db[currentMonth]) { db[currentMonth] = {}; }
            if(!db[currentMonth][currentWs]) {
                db[currentMonth][currentWs] = { S:{}, Q:{}, D:{}, I:{}, P:{} };
                let days = getDaysInMonth(currentMonth);
                Object.keys(db[currentMonth][currentWs]).forEach(m => {
                    let conf = CONFIG[m];
                    for(let i=1; i<=31; i++) {
                        db[currentMonth][currentWs][m][i] = { tgt: conf.tgt, act: null, gap: 0, isGreen: false, reason: '', invalid: (i > days), status: '未解决', close_time: '', owner: '' };
                        if(i <= 20 && i <= days) {
                            let isFail = Math.random() > 0.85; 
                            if(m === 'S' || m === 'D' || m === 'I') {
                                db[currentMonth][currentWs][m][i].act = isFail ? conf.tgt + Math.floor(Math.random()*50) + 1 : conf.tgt;
                                db[currentMonth][currentWs][m][i].isGreen = db[currentMonth][currentWs][m][i].act <= conf.tgt;
                            } else {
                                let offset = (m==='Q') ? (Math.random()*1).toFixed(1) : Math.floor(Math.random()*3);
                                db[currentMonth][currentWs][m][i].act = isFail ? conf.tgt - offset - 0.1 : conf.tgt + offset;
                                db[currentMonth][currentWs][m][i].isGreen = db[currentMonth][currentWs][m][i].act >= conf.tgt;
                            }
                            if(isFail) {
                                db[currentMonth][currentWs][m][i].reason = "设备突发故障。";
                                db[currentMonth][currentWs][m][i].status = (Math.random() > 0.5) ? '处理中' : '未解决';
                                db[currentMonth][currentWs][m][i].owner = "张三";
                            }
                            db[currentMonth][currentWs][m][i].gap = (db[currentMonth][currentWs][m][i].act - db[currentMonth][currentWs][m][i].tgt).toFixed(1);
                        }
                    }
                });
                triggerAutoSaveSQDIP();
            }
            refreshAllUI();
        }
        function refreshAllUI() {
            renderScorecard();
            if(document.getElementById('sqdip-adv-page-main').classList.contains('active')) {
                renderMacroBoard();
                renderMacroTrend();
            } else {
                renderTable();
                renderChart();
            }
        }
        // ================= 3. 看板与记分卡渲染 =================
        function renderScorecard() {
            // 防御性检查：确保数据存在
            if (!currentMonth || !db[currentMonth] || !db[currentMonth][currentWs]) {
                console.warn('[renderScorecard] 数据未初始化');
                return;
            }
            let days = getDaysInMonth(currentMonth);
            let wsData = db[currentMonth][currentWs];
            let totalDays = 0, totalOks = 0;
            ['S','Q','D','I','P'].forEach(m => {
                let metricOk = 0, metricRecorded = 0;
                for(let i=1; i<=days; i++) {
                    if(wsData[m][i].act !== null) {
                        metricRecorded++; totalDays++;
                        if(wsData[m][i].isGreen) { metricOk++; totalOks++; }
                    }
                }
                let color = metricRecorded > 0 ? (metricOk===metricRecorded?'var(--success)':'var(--danger)') : 'var(--text-muted)';
                document.getElementById(`sqdip-adv-sc-${m.toLowerCase()}`).innerHTML = `<span style="color:${color}">${metricOk} / ${metricRecorded}</span>`;
            });
            let rate = totalDays > 0 ? (totalOks / totalDays * 100).toFixed(1) : 0;
            document.getElementById('sqdip-adv-sc-total-rate').innerText = rate + '%';
            document.getElementById('sqdip-adv-sc-total-rate').style.color = rate >= 95 ? 'var(--success)' : (rate >= 80 ? 'var(--warning)' : 'var(--danger)');
            let risksHtml = '';
            ['S','Q','D','I','P'].forEach(m => {
                let consecutiveNg = 0;
                for(let i=days; i>=1; i--) {
                    if(wsData[m][i].act !== null) {
                        if(!wsData[m][i].isGreen) consecutiveNg++;
                        else break;
                    }
                }
                if(consecutiveNg >= 2) {
                    risksHtml += `<div style="background:rgba(239, 68, 68, 0.1); border-left:4px solid var(--danger); padding:6px 10px; border-radius:4px; font-size:11px; font-weight:700;"><span style="color:var(--danger)">${m} 指标</span> 连续异常 ${consecutiveNg} 天</div>`;
                }
            });
            document.getElementById('sqdip-adv-high-risk-list').innerHTML = risksHtml || '<div style="font-size:11px; color:var(--success); font-weight:700; padding:8px; background:rgba(16,185,129,0.1); border-radius:6px;"><i class="fa-solid fa-check-circle"></i> 当前车间无高危倾向</div>';
        }
        function renderMacroBoard() {
            // 防御性检查
            if (!currentMonth || !db[currentMonth] || !db[currentMonth][currentWs]) {
                console.warn('[renderMacroBoard] 数据未初始化');
                return;
            }
            Object.keys(LETTER_SHAPES).forEach(letter => {
                const grid = document.getElementById(`sqdip-adv-grid-${letter}`);
                const activeIndices = LETTER_SHAPES[letter].sort((a,b) => a-b);
                let html = '';
                for(let index = 0; index < 49; index++) {
                    let positionInShape = activeIndices.indexOf(index);
                    if (positionInShape !== -1) {
                        let dayCounter = positionInShape + 1;
                        if (dayCounter <= 31) {
                            let data = db[currentMonth][currentWs][letter][dayCounter];
                            if(data.invalid) {
                                html += `<div class="day-cell disabled"></div>`;
                            } else {
                                let statusClass = '';
                                if(data.act !== null) {
                                    statusClass = data.isGreen ? 'status-green' : 'status-red';
                                }
                                html += `<div class="day-cell active ${statusClass}" title="${dayCounter}号">${dayCounter}</div>`;
                            }
                        } else {
                            html += `<div class="day-cell disabled"></div>`;
                        }
                    } else {
                        html += `<div class="day-cell empty"></div>`;
                    }
                }
                grid.innerHTML = html;
            });
        }
        function renderMacroTrend() {
            let days = getDaysInMonth(currentMonth);
            let labels = Array.from({length: days}, (_, i) => i + 1 + '日');
            let dataS = [];
            for(let i=1; i<=days; i++) {
                let wsData = db[currentMonth][currentWs];
                let acts = 0, oks = 0;
                ['S','Q','D','I','P'].forEach(m => {
                    if(wsData[m][i].act !== null) {
                        acts++;
                        if(wsData[m][i].isGreen) oks++;
                    }
                });
                dataS.push(acts > 0 ? (oks/acts*100).toFixed(0) : null);
            }
            const canvas = document.getElementById('sqdip-adv-macroTrendChart');
            const ctx = canvas.getContext('2d');
            if(macroChartObj) macroChartObj.destroy();
            macroChartObj = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: `${currentWs} 车间综合达标率 (%)`,
                        data: dataS,
                        borderColor: '#0284c7', backgroundColor: 'rgba(2, 132, 199, 0.15)',
                        borderWidth: 2, pointRadius: 4, spanGaps: true, tension: 0.3, fill: true
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'top', labels:{font:{weight:'bold', size:12}} } },
                    scales: { 
                        y: { min: 0, max: 100, grid: { color: 'rgba(0,0,0,0.05)' } }, 
                        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 } } 
                    }
                }
            });
        }
        // ================= 4. 详情穿透与录入 =================
        function openDetail(letter) {
            currentMetric = letter;
            let conf = CONFIG[letter];
            document.getElementById('sqdip-adv-page-main').classList.remove('active');
            document.getElementById('sqdip-adv-page-detail').classList.add('active');
            // 二级页面隐藏左侧面板（月度综合表现 / 整体达成率 / 高危异常）
            var sb = document.querySelector('.sqdip-adv-root .sidebar-panel');
            if(sb) sb.style.display = 'none';
            document.getElementById('sqdip-adv-detail-title').innerText = `${letter} : ${conf.title} (${currentWs})`;
            document.getElementById('sqdip-adv-detail-subtitle').innerText = conf.sub;
            document.getElementById('sqdip-adv-detail-rule').innerHTML = conf.rule;
            var extSub = document.getElementById('sqdip-adv-ext-subtitle');
            if(extSub) extSub.innerText = conf.sub;
            var extRule = document.getElementById('sqdip-adv-ext-rule');
            if(extRule) extRule.innerHTML = '';
            document.getElementById('sqdip-adv-f-date').value = '';
            document.getElementById('sqdip-adv-f-status').value = '';
            document.getElementById('sqdip-adv-f-reason').value = '';
            renderTable();
            setTimeout(() => { renderChart(); }, 50);
        }
        function closeDetail() {
            document.getElementById('sqdip-adv-page-detail').classList.remove('active');
            document.getElementById('sqdip-adv-page-main').classList.add('active');
            // 返回主界面时恢复左侧面板
            var sb = document.querySelector('.sqdip-adv-root .sidebar-panel');
            if(sb) sb.style.display = '';
            renderScorecard();
            renderMacroBoard(); 
            renderMacroTrend();
        }
        api.quickFillMonth = function() {
            if(!confirm(`确定要将 ${currentMonth} 月 ${currentMetric} 指标所有NG日期改为达标(OK)吗？`)) return;
            let days = getDaysInMonth(currentMonth);
            let changed = 0;
            for(let i=1; i<=days; i++) {
                let d = db[currentMonth][currentWs][currentMetric][i];
                // 如果实际值为空或者不是绿色（NG），就改为达标
                if(d.act === null || !d.isGreen) {
                    if(d.act === null) d.act = d.tgt;
                    d.gap = 0;
                    d.isGreen = true;
                    d.reason = "达标";
                    d.status = "已解决";
                    changed++;
                }
            }
            triggerAutoSaveSQDIP();
            renderTable(true);
            renderChart();
            showToast('fa-solid fa-check', `已将 ${changed} 个NG日期改为达标`);
        };
        function handleInput(day, field, val) {
            let record = db[currentMonth][currentWs][currentMetric][day];
            
            if(['reason', 'status', 'close_time', 'owner'].includes(field)) {
                record[field] = val;
            } else {
                let numVal = parseFloat(val);
                if(!isNaN(numVal)) {
                    record[field] = numVal;
                    
                    // 总是重新计算差值（无论编辑的是目标还是实际）
                    if(record.tgt !== null && record.act !== null) {
                        record.gap = (record.act - record.tgt).toFixed(1);
                    } else {
                        record.gap = 0;
                    }
                    
                    // 重新判定是否达标
                    if(record.tgt !== null && record.act !== null) {
                        if(currentMetric === 'S' || currentMetric === 'D' || currentMetric === 'I') {
                            // S(安全)、D(交付)、I(库存) - 实际值 <= 目标值 为达标
                            record.isGreen = record.act <= record.tgt; 
                        } else {
                            // Q(质量)、P(效率) - 实际值 >= 目标值 为达标
                            record.isGreen = record.act >= record.tgt; 
                        }
                    } else {
                        record.isGreen = false;
                    }
                    
                } else if(val === '') {
                    // 清空实际值
                    if(field === 'act') {
                        record.act = null; 
                        record.gap = 0; 
                        record.isGreen = false;
                    }
                    // 清空目标值
                    if(field === 'tgt') {
                        record.tgt = null;
                        record.gap = 0;
                        record.isGreen = false;
                    }
                }
            }
            
            triggerAutoSaveSQDIP();
            renderTable(true);
            renderChart(); // 总是重新渲染图表
        }
        function renderTable(isUpdate = false) {
            let fDate = document.getElementById('sqdip-adv-f-date').value.trim();
            let fStatus = document.getElementById('sqdip-adv-f-status').value;
            let fReason = document.getElementById('sqdip-adv-f-reason').value.trim().toLowerCase();
            const tbody = document.getElementById('sqdip-adv-detail-tbody');
            let html = '';
            let alertCount = 0;
            let daysInMonth = getDaysInMonth(currentMonth);
            let todos = [];
            // ★ 自动修复：确保1~daysInMonth所有日期都有数据记录
            if(db[currentMonth] && db[currentMonth][currentWs] && db[currentMonth][currentWs][currentMetric]) {
                for(let i=1; i<=daysInMonth; i++) {
                    if(!db[currentMonth][currentWs][currentMetric][i]) {
                        let conf = CONFIG[currentMetric];
                        db[currentMonth][currentWs][currentMetric][i] = { tgt: conf.tgt, act: null, gap: 0, isGreen: false, reason: '', invalid: false, status: '未解决', close_time: '', owner: '' };
                    }
                }
            }
            for(let i=1; i<=daysInMonth; i++) {
                let d = db[currentMonth][currentWs][currentMetric][i];
                let actVal = d.act !== null ? d.act : '';
                if(d.act !== null && !d.isGreen) {
                    alertCount++;
                    if(d.status !== '已解决') {
                        todos.push({ day: i, reason: d.reason || '无记录', owner: d.owner || '-', status: d.status });
                    }
                }
                let statusType = d.act === null ? '' : (d.isGreen ? 'OK' : 'NG');
                if(fDate && !String(i).includes(fDate)) continue;
                if(fStatus && statusType !== (fStatus==='green'?'OK':'NG') && fStatus !== '') continue;
                if(fReason && !(d.reason.toLowerCase().includes(fReason) || d.owner.toLowerCase().includes(fReason))) continue;
                let gapHtml = d.act === null ? '-' : d.gap;
                if(d.act !== null) {
                    let isBadGap = (currentMetric === 'S' || currentMetric === 'D' || currentMetric === 'I') ? (d.gap > 0) : (d.gap < 0);
                    gapHtml = `<span style="font-weight:900; color: ${isBadGap ? 'var(--danger)' : 'var(--success)'}">${d.gap > 0 ? '+'+d.gap : d.gap}</span>`;
                }
                let statusHtml = '-';
                if(d.act !== null) {
                    statusHtml = d.isGreen ? `<span class="status-badge badge-ok"><i class="fa-solid fa-check"></i> OK</span>` : `<span class="status-badge badge-ng"><i class="fa-solid fa-xmark"></i> NG</span>`;
                }
                let sColor = d.status === '已解决' ? 'var(--success)' : (d.status === '处理中' ? 'var(--warning)' : 'var(--danger)');
                html += `
                <tr>
                    <td style="font-weight:900; color:var(--midea-dark);">${i} 日</td>
                    <td><input type="number" class="data-input" value="${d.tgt}" onchange="handleInput(${i}, 'tgt', this.value)"></td>
                    <td><input type="number" class="data-input" value="${actVal}" placeholder="-" style="color:var(--midea-blue);" onchange="handleInput(${i}, 'act', this.value)"></td>
                    <td>${gapHtml}</td>
                    <td>${statusHtml}</td>
                    <td><input type="text" class="data-input reason-input" value="${d.reason}" placeholder="请输入原因..." onchange="handleInput(${i}, 'reason', this.value)"></td>
                    <td>
                        <select class="status-select" style="color:${sColor};" onchange="handleInput(${i}, 'status', this.value)">
                            <option value="未解决" ${d.status==='未解决'?'selected':''}>未解决</option>
                            <option value="处理中" ${d.status==='处理中'?'selected':''}>处理中</option>
                            <option value="已解决" ${d.status==='已解决'?'selected':''}>已解决</option>
                        </select>
                    </td>
                    <td><input type="date" class="data-input" style="padding:0; font-size:10px;" value="${d.close_time}" onchange="handleInput(${i}, 'close_time', this.value)"></td>
                    <td><input type="text" class="data-input" value="${d.owner}" placeholder="责任人" onchange="handleInput(${i}, 'owner', this.value)"></td>
                </tr>`;
            }
            tbody.innerHTML = html;
            if(!fDate && !fStatus && !fReason) {
                document.getElementById('sqdip-adv-alert-days').innerText = alertCount;
            }
            const todoList = document.getElementById('sqdip-adv-todo-list');
            if(todos.length === 0) {
                todoList.innerHTML = `<li style="font-size:11px; color:var(--text-muted); text-align:center; padding:10px;">🎉 无遗留待办事项</li>`;
            } else {
                todoList.innerHTML = todos.map(t => `
                    <li class="todo-item ${t.status==='处理中'?'warn':''}">
                        <div style="display:flex; justify-content:space-between;">
                            <span style="font-weight:900; color:var(--danger);">${t.day}日异常</span>
                            <span style="color:${t.status==='处理中'?'var(--warning)':'var(--danger)'}; font-weight:900;">${t.status}</span>
                        </div>
                        <div style="color:var(--text-main); font-size:11px; margin: 2px 0; font-weight:800;">${t.reason}</div>
                        <div style="color:var(--text-muted); font-size:10px;"><i class="fa-solid fa-user" style="color:var(--midea-blue)"></i> ${t.owner}</div>
                    </li>
                `).join('');
            }
        }
        function renderChart() {
            let labels = []; let actData = []; let tgtData = [];
            let daysInMonth = getDaysInMonth(currentMonth);
            for(let i=1; i<=daysInMonth; i++) {
                labels.push(`${i}日`);
                tgtData.push(db[currentMonth][currentWs][currentMetric][i].tgt);
                actData.push(db[currentMonth][currentWs][currentMetric][i].act !== null ? db[currentMonth][currentWs][currentMetric][i].act : null);
            }
            const canvas = document.getElementById('sqdip-adv-trendChart');
            const ctx = canvas.getContext('2d');
            if(chartObj) chartObj.destroy();
            chartObj = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: `实际达成`,
                            data: actData,
                            borderColor: '#0284c7', backgroundColor: '#0284c7',
                            borderWidth: 2, pointRadius: 4, spanGaps: true, tension: 0.2
                        },
                        {
                            label: `基准线`,
                            data: tgtData,
                            borderColor: '#ef4444', backgroundColor: '#ef4444',
                            borderWidth: 2, borderDash: [4, 4], pointRadius: 0, fill: false, tension: 0
                        }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { position: 'top', labels:{font:{weight:'bold', size: 11}} } },
                    scales: { 
                        y: { grace: '15%', grid: { color: 'rgba(0,0,0,0.05)' } }, 
                        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 } } 
                    }
                }
            });
        }
        async function init() {
            let today = new Date();
            document.getElementById('sqdip-adv-month-selector').value = '2026-04'; 
            // 先从 localStorage 加载
            let saved = localStorage.getItem(DB_KEY);
            if(saved) { 
                try { db = JSON.parse(saved); } catch(e) { console.error('localStorage parse error:', e); }
            }
            // 如果 Firebase 已就绪，从云端加载
            if (isFirebaseReadySQDIP && window.firebaseDatabase) {
                try {
                    const sqdipRef = window.firebaseRef(window.firebaseDatabase, 'sqdip_board');
                    const snapshot = await window.firebaseGet(sqdipRef);
                    const data = snapshot.val();
                    // 只有当云端数据有效（有月份键）时才覆盖本地
                    if(data && data.db && Object.keys(data.db).length > 0) {
                        db = data.db;
                        try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
                    }
                } catch(e) {
                    console.error('Firebase load failed:', e);
                }
            }
            updateCloudStatus();
            // 确保 currentMonth 有值
            currentMonth = document.getElementById('sqdip-adv-month-selector').value || '2026-04';
            changeMonth(); 
        }
        api.changeWs = changeWs;
        api.changeMonth = changeMonth;
        api.openDetail = openDetail;
        api.closeDetail = closeDetail;
        api.renderTable = renderTable;
        api.handleInput = handleInput;
        api.refresh = refreshAllUI;
        api.init = async function(){ try { await init(); } catch(e) { console.error('SQDIP init failed', e); } };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', api.init, { once: true }); else api.init();
    })();
    
    


// ================= 设备点检模块（简化版：选月份自动生成）=================
// === 数据结构 ===
// { id, date, time, checkPlace, ws, dept, checked, photo, notes }
// === 自动逻辑 ===
// 选月份 → 检查该月是否有数据 → 无则自动生成每天一行 → 渲染

// 获取当前设备点检对应的年份
function equipGetYear() {
    var monthFromSelect = document.getElementById('equip-month-select');
    if (monthFromSelect) {
        var m = parseInt(monthFromSelect.value) || (new Date().getMonth() + 1);
        var year = new Date().getFullYear();
        // 如果当前月份小于选中月份，说明选的是下一年（用于12月选1月的情况）
        // 但简单起见，先用当前年
        return year;
    }
    return new Date().getFullYear();
}

// 获取设备点检对应的月份字符串 YYYY-MM
function equipGetMonthStr() {
    var monthSelect = document.getElementById('equip-month-select');
    var m = monthSelect ? parseInt(monthSelect.value) : (new Date().getMonth() + 1);
    var year = new Date().getFullYear();
    return year + '-' + (m < 10 ? '0' + m : m);
}

// 获取当前选中月份的数字（1-12）
function equipGetMonthNum() {
    var monthSelect = document.getElementById('equip-month-select');
    return monthSelect ? parseInt(monthSelect.value) : (new Date().getMonth() + 1);
}

// 确保当月数据存在（自动生成缺失的天数）
// 自动生成系统运作模块的每日预设数据
function ensureSysDetailPresetData(month, type) {
    if (!db) return;
    if (!db.sysDetail) db.sysDetail = {};
    if (!db.sysDetail[type]) db.sysDetail[type] = [];
    
    var parts = month.split('-');
    if (parts.length < 2) return;
    var year = parseInt(parts[0]);
    var monthNum = parseInt(parts[1]);
    var daysInMonth = new Date(year, monthNum, 0).getDate();
    var createdCount = 0;
    
    // ★ 修复：不再先清除旧数据！之前每次打开都清空当月所有用户录入后重建
    //   改为只补充缺失的日期，已有用户数据的日期保留不动
    
    // ★ 修复：跳过用户手动删除的日期
    var skipDates = db.sysDetail._skipDates && db.sysDetail._skipDates[type] ? db.sysDetail._skipDates[type] : {};
    
    // 收集当月已有的日期
    var existingDates = {};
    db.sysDetail[type].forEach(function(r) {
        if (r && r.date && String(r.date || '').startsWith(month)) {
            existingDates[r.date] = true;
        }
    });
    
    for (var day = 1; day <= daysInMonth; day++) {
        var dateStr = month + '-' + (day < 10 ? '0' + day : day);
        // 已有数据则跳过，不覆盖用户录入
        if (existingDates[dateStr]) continue;
        // 用户手动删除的则跳过，不再自动生成
        if (skipDates[dateStr]) continue;
        
        var record;
        if (type === 'pre') {
            record = {
                id: Date.now() + Math.random() + Math.random(),
                date: dateStr,
                ws: 'PRO2',
                ownerDept: 'PRO2',
                line: 'LINE A',
                equipment: '',
                item: '',
                issue: '',
                resp: '',
                status: '未完成'
            };
        } else if (type === 'mid') {
            record = {
                id: Date.now() + Math.random() + Math.random(),
                date: dateStr,
                ws: 'PRO2',
                line: 'LINE A',
                event: '',
                responseMin: 0,
                waitMin: 0,
                impactQty: 0,
                patrol: '',
                action: '',
                resp: '',
                status: '已关闭'
            };
        } else if (type === 'equipment') {
            record = {
                id: Date.now() + Math.random() + Math.random(),
                date: dateStr,
                time: '08:00',
                checkPlace: '',
                ws: 'PRO2',
                dept: 'PRO2',
                checked: false,
                photo: '',
                notes: ''
            };
        }
        if (record) {
            db.sysDetail[type].push(record);
            createdCount++;
        }
    }
    
    if (createdCount > 0) {
        db.sysDetail[type].sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
        if (window.triggerAutoSave) window.triggerAutoSave();
    }
}

function ensureEquipmentData() {
    if (!db.sysDetail) db.sysDetail = {};
    if (!db.sysDetail.equipment) db.sysDetail.equipment = [];
    
    var monthStr = equipGetMonthStr();
    var parts = monthStr.split('-');
    if (parts.length < 2) return;
    var year = parseInt(parts[0]);
    var monthNum = parseInt(parts[1]);
    var daysInMonth = new Date(year, monthNum, 0).getDate();
    
    // ★ 修复：不再清空旧数据！只补充缺失日期，已有用户的录入保留
    // ★ 修复：跳过用户手动删除的设备点检日期
    var skipDates = db.sysDetail && db.sysDetail._skipDates && db.sysDetail._skipDates.equipment ? db.sysDetail._skipDates.equipment : {};
    
    var existingDates = {};
    db.sysDetail.equipment.forEach(function(r) {
        if (r && r.date && String(r.date || '').startsWith(monthStr)) {
            existingDates[r.date] = true;
        }
    });
    
    var createdCount = 0;
    for (var day = 1; day <= daysInMonth; day++) {
        var dateStr = monthStr + '-' + (day < 10 ? '0' + day : day);
        // 已有数据则跳过
        if (existingDates[dateStr]) continue;
        // 用户手动删除的则跳过，不再自动生成
        if (skipDates[dateStr]) continue;
        db.sysDetail.equipment.push({
            id: Date.now() + Math.random() + Math.random(),
            date: dateStr,
            time: '08:00',
            checkPlace: '',
            ws: 'PRO2',
            dept: 'PE',
            checked: false,
            photo: '',
            notes: ''
        });
        createdCount++;
    }
    
    if (createdCount > 0) {
        // Sort by date
        db.sysDetail.equipment.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
        if (window.triggerAutoSave) window.triggerAutoSave();
    }
}

// 月份变更时触发
// 事后模块：自动生成DM每日打卡数据
window.ensurePostDmPunchData = function(month) {
    if (!db || !db.sysDetail) return;
    if (!db.sysDetail.post) db.sysDetail.post = [];
    
    var parts = month.split('-');
    if (parts.length < 2) return;
    var year = parseInt(parts[0]);
    var monthNum = parseInt(parts[1]);
    var daysInMonth = new Date(year, monthNum, 0).getDate();
    
    var skipDates = db.sysDetail._skipDates && db.sysDetail._skipDates.post ? db.sysDetail._skipDates.post : {};
    
    // 收集当月已有的DM打卡记录
    var existingDmDates = {};
    db.sysDetail.post.forEach(function(r) {
        if (r && r.type === 'dm_punch' && r.date && String(r.date).startsWith(month)) {
            existingDmDates[r.date] = true;
        }
    });
    
    var createdCount = 0;
    for (var day = 1; day <= daysInMonth; day++) {
        var dateStr = month + '-' + (day < 10 ? '0' + day : day);
        if (existingDmDates[dateStr]) continue;
        if (skipDates[dateStr]) continue;
        db.sysDetail.post.push({
            id: Date.now() + Math.random() + Math.random(),
            date: dateStr,
            type: 'dm_punch',
            dmDone: false
        });
        createdCount++;
    }
    
    if (createdCount > 0) {
        db.sysDetail.post.sort(function(a, b) { return (a.date||'').localeCompare(b.date||''); });
        if (window.triggerAutoSave) window.triggerAutoSave();
    }
};

window.onEquipMonthChange = function() {
    ensureEquipmentData();
    renderEquipmentTable();
};

// 渲染设备点检表格
window.renderEquipmentTable = function() {
    console.log('[renderEquipTable] start');
    var monthStr = equipGetMonthStr();
    var wsFilter = document.getElementById('equip-ws-filter') 
        ? document.getElementById('equip-ws-filter').value : '';
    
    var allData = (db && db.sysDetail && db.sysDetail.equipment) 
        ? db.sysDetail.equipment : [];
    console.log('[renderEquipTable] allData len=' + allData.length);
    
    // Filter by month
    var rows = allData.filter(function(r) { return String(r.date || '').startsWith(monthStr); });
    if (wsFilter) {
        rows = rows.filter(function(r) { return r.ws === wsFilter; });
    }
    
    var body = document.getElementById('sys-detail-body');
    if (!body) return;
    
    // Statistics
    var total = rows.length;
    var checkedCount = rows.filter(function(r) { return r.checked === true; }).length;
    var checkRate = total > 0 ? (checkedCount / total * 100).toFixed(1) : '0.0';
    
    // ★ 修复Bug1:先更新KPI标签（防止切换模块后标签被上次模块的值污染）
    var _labelEl = document.getElementById('sys-kpi-1-label'); if (_labelEl) _labelEl.innerText = '总天数';
    _labelEl = document.getElementById('sys-kpi-2-label'); if (_labelEl) _labelEl.innerText = '点检率';
    _labelEl = document.getElementById('sys-kpi-3-label'); if (_labelEl) _labelEl.innerText = '未打卡';
    _labelEl = document.getElementById('sys-kpi-4-label'); if (_labelEl) _labelEl.innerText = '——';
    _labelEl = document.getElementById('sys-detail-impact'); if (_labelEl) { _labelEl.innerText = '—'; _labelEl.style.color = ''; }
    
    // Update standard KPI strip (sys-detail-count, sys-detail-rate, sys-detail-risk)
    var el;
    el = document.getElementById('sys-detail-count'); if (el) el.innerText = total + '天';
    el = document.getElementById('sys-detail-rate'); if (el) {
        el.innerText = checkRate + '%';
        el.style.color = parseFloat(checkRate) >= 95 ? 'var(--success)' : (parseFloat(checkRate) >= 80 ? 'var(--warning)' : 'var(--danger)');
    }
    el = document.getElementById('sys-detail-risk'); if (el) {
        el.innerText = (total - checkedCount) + '天未打卡';
        el.style.color = (total - checkedCount) > 0 ? 'var(--danger)' : 'var(--success)';
    }
    
    // Render table rows
    body.innerHTML = rows.length ? rows.map(function(r, idx) {
        // ★ 用全局索引替代筛选后的索引：从完整数组中查找真实位置
        var gIdx = allData.indexOf(r);
        if (gIdx < 0) gIdx = idx; // 兜底
        var photoHtml = '';
        if (r.photo && String(r.photo).length > 100) {
            // ★ 修复：有图时点击预览，双击更换
            photoHtml = '<div style="position:relative;display:inline-block;"><img src="' + r.photo + '" style="width:32px;height:32px;object-fit:cover;border-radius:4px;cursor:pointer;border:1px solid #eee;" onclick="window.openPhotoPreview(\'' + r.photo + '\')" ondblclick="equipOpenPhotoModal(' + gIdx + ')" title="单击预览 / 双击更换">' +
                '<span style="position:absolute;bottom:-2px;right:-4px;font-size:7px;background:#0284c7;color:white;border-radius:8px;padding:0 3px;cursor:pointer;line-height:14px;" onclick="event.stopPropagation();equipOpenPhotoModal(' + gIdx + ')">换</span></div>';
        } else {
            // ★ 修复：点击弹出图片粘贴窗口（Ctrl+V/拖放/文件选择），不再用内联粘贴
            photoHtml = '<div class="equip-photo-zone" style="width:32px;height:32px;border:1px dashed #0284c7;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#0284c7;cursor:pointer;padding:0 2px;background:rgba(2,132,199,0.05);" onclick="equipOpenPhotoModal(' + gIdx + ')" title="点击打开图片粘贴窗口">📷粘贴</div>';
        }
        
        return '<tr>' +
            '<td style="text-align:center;font-size:11px;">' + (r.date || '') + '</td>' +
            '<td style="text-align:center;"><input type="text" value="' + (r.checkPlace || '') + '" onchange="equipUpdateField(' + gIdx + ', \'checkPlace\', this.value)" placeholder="点检位置" style="width:95%;text-align:left;font-size:12px;"></td>' +
            '<td style="text-align:center;"><select onchange="equipUpdateField(' + gIdx + ', \'ws\', this.value)" style="width:80px;text-align:center;font-size:12px;">' +
                '<option value="PRO1"' + (r.ws==='PRO1'?' selected':'') + '>PRO1</option>' +
                '<option value="PRO2"' + (r.ws==='PRO2'?' selected':'') + '>PRO2</option>' +
                '<option value="PRO3"' + (r.ws==='PRO3'?' selected':'') + '>PRO3</option>' +
                '<option value="PRO4"' + (r.ws==='PRO4'?' selected':'') + '>PRO4</option>' +
            '</select></td>' +
            '<td style="text-align:center;"><select onchange="equipUpdateField(' + gIdx + ', \'dept\', this.value)" style="width:90%;text-align:center;font-size:12px;">' +
                '<option value="PE"' + ((r.dept||'PE')==='PE'?' selected':'') + '>PE设备部门</option>' +
                '<option value="品质"' + ((r.dept||'')==='品质'?' selected':'') + '>品质</option>' +
                '<option value="工艺"' + ((r.dept||'')==='工艺'?' selected':'') + '>工艺</option>' +
                '<option value="模具"' + ((r.dept||'')==='模具'?' selected':'') + '>模具</option>' +
                '<option value="生产"' + ((r.dept||'')==='生产'?' selected':'') + '>生产</option>' +
                '<option value="物流"' + ((r.dept||'')==='物流'?' selected':'') + '>物流</option>' +
                '<option value="其他"' + ((r.dept||'')==='其他'?' selected':'') + '>其他</option>' +
            '</select></td>' +
            '<td style="text-align:center;"><input type="checkbox" ' + (r.checked ? 'checked' : '') + ' onchange="equipToggleCheck(' + gIdx + ', this.checked)" style="width:18px;height:18px;cursor:pointer;"></td>' +
            '<td style="text-align:center;vertical-align:middle;">' + photoHtml + '</td>' +
            '<td style="text-align:center;"><i class="fa-solid fa-xmark" style="color:var(--danger);cursor:pointer;font-size:14px;opacity:0.6;transition:0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6" onclick="equipDeleteRow(' + gIdx + ')" title="删除该行"></i></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:#999;">暂无设备点检记录</td></tr>';
            
        };
        
        
// --- Helper functions ---

window.equipUpdateField = function(index, field, value) {
    try {
        var arr = db && db.sysDetail && db.sysDetail.equipment;
        if (arr && arr[index]) {
            arr[index][field] = value;
            if (window.triggerAutoSave) window.triggerAutoSave();
        }
    } catch(e) { console.error('[equipUpdate ERROR]', e.message, 'line', e.lineNumber); }
};

window.equipToggleCheck = function(index, checked) {
    try {
        var arr = db && db.sysDetail && db.sysDetail.equipment;
        console.log('[equipToggle] index=' + index + ' arrLen=' + (arr?arr.length:0) + ' exists=' + (arr&&arr[index]?true:false));
        if (arr && arr[index]) {
            arr[index].checked = checked;
            if (window.triggerAutoSave) window.triggerAutoSave();
            renderEquipmentTable();
            if (typeof renderSysOps === 'function') renderSysOps();
        }
    } catch(e) { console.error('[equipToggle ERROR]', e.message, 'line', e.lineNumber); }
};

window.equipDeleteRow = function(index) {
    if (!db || !db.sysDetail || !db.sysDetail.equipment || !db.sysDetail.equipment[index]) return;
    var r = db.sysDetail.equipment[index];
    if (!confirm('确认删除 ' + (r.date||'') + ' 的设备点检记录？')) return;
    var delDate = r.date;
    db.sysDetail.equipment.splice(index, 1);
    // ★ 修复Bug6:标记该日期已删除，防止ensureEquipmentData重新生成
    if (!db.sysDetail._skipDates) db.sysDetail._skipDates = {};
    if (!db.sysDetail._skipDates.equipment) db.sysDetail._skipDates.equipment = {};
    db.sysDetail._skipDates.equipment[delDate] = true;
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e) { console.warn('[equipDeleteRow] localStorage保存失败', e); }
    if (window.forceSaveToFirebase) { window.forceSaveToFirebase().catch(function(){}); } else if (window.triggerAutoSave) { window.triggerAutoSave(); }
    renderEquipmentTable();
};

window.equipHandleFileSelect = function(index, input) {
    var file = input.files[0];
    if (!file) return;
    equipProcessPhoto(index, file);
    input.value = '';
};





window.equipProcessPhoto = function(index, file) {
    if (file.size > 2 * 1024 * 1024) { alert('图片大小不能超过2MB'); return; }
    var reader = new FileReader();
    reader.onload = function(e) { equipSavePhoto(index, e.target.result); };
    reader.readAsDataURL(file);
};

window.equipProcessBlob = function(index, blob) {
    if (blob.size > 2 * 1024 * 1024) { alert('图片大小不能超过2MB'); return; }
    var reader = new FileReader();
    reader.onload = function(e) { equipSavePhoto(index, e.target.result); };
    reader.readAsDataURL(blob);
};

window.equipSavePhoto = function(index, dataUrl) {
    if (!db || !db.sysDetail || !db.sysDetail.equipment || !db.sysDetail.equipment[index]) return;
    equipCompressImage(dataUrl, 150, 0.4).then(function(compressed) {
        db.sysDetail.equipment[index].photo = compressed;
        if (window.triggerAutoSave) window.triggerAutoSave();
        renderEquipmentTable();
        if (typeof renderSysOps === 'function') renderSysOps();
        if (window.showToast) window.showToast('fa-solid fa-check-circle', '图片已添加');
    });
};

window.equipCompressImage = function(dataUrl, maxWidth, quality) {
    return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() {
            var canvas = document.createElement('canvas');
            var w = img.width, h = img.height;
            if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = dataUrl;
    });
};

window.openPhotoPreview = function(dataUrl) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;justify-content:center;align-items:center;z-index:10001;';
    overlay.innerHTML = '<div style="background:white;padding:8px;border-radius:8px;max-width:400px;">' +
        '<div style="text-align:right;margin-bottom:4px;"><button onclick="this.parentElement.parentElement.parentElement.remove()" style="background:none;border:none;font-size:16px;cursor:pointer;">x</button></div>' +
        '<img src="' + dataUrl + '" style="max-width:360px;max-height:60vh;display:block;border-radius:4px;">' +
    '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
};

// Export report
window.exportEquipmentReport = function() {
    var monthStr = equipGetMonthStr();
    var rows = (db && db.sysDetail && db.sysDetail.equipment) 
        ? db.sysDetail.equipment.filter(function(r) { return String(r.date || '').startsWith(monthStr); }) : [];
    var total = rows.length;
    var checked = rows.filter(function(r) { return r.checked === true; }).length;
    var today = new Date().toLocaleDateString('zh-CN');
    var csv = '设备点检统计表,' + today + '\n\n';
    csv += '项目,数量\n总天数,' + total + '\n已打卡,' + checked + '\n未打卡,' + (total - checked) + '\n点检率,' + (total > 0 ? (checked/total*100).toFixed(1) : '0.0') + '%';
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '设备点检_' + monthStr + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (window.showToast) window.showToast('fa-solid fa-file-export', '报表已导出');
};

// ★ 设备点检图片粘贴弹出窗口（解决小区域无法聚焦粘贴的问题）
window.currentEquipmentPhotoIndex = null;
window._equipModalDataUrl = null; // 当前模态框中的原始图片数据
window._equipModalCompressed = null; // 当前模态框中的压缩后图片数据

// 打开图片粘贴弹出窗口
window.equipOpenPhotoModal = function(index) {
    currentEquipmentPhotoIndex = index;
    _equipModalDataUrl = null;
    _equipModalCompressed = null;
    
    // 如果已有图片，先加载
    var row = db && db.sysDetail && db.sysDetail.equipment && db.sysDetail.equipment[index];
    if (row && row.photo) {
        _equipModalDataUrl = row.photo;
        equipModalUpdatePreview();
    }
    
    document.getElementById('equip-photo-modal').style.display = 'flex';
    
    // 先清理旧的粘贴监听器（如果之前关闭时未清理）
    if (window._equipModalPasteHandler) {
        document.removeEventListener('paste', window._equipModalPasteHandler);
        delete window._equipModalPasteHandler;
    }
    
    // ★ 隐藏textarea自动获焦：浏览器需要可编辑元素捕获粘贴事件
    setTimeout(function() {
        var _ta = document.getElementById('equip-photo-paste-textarea');
        if (_ta) { _ta.focus(); _ta.select(); }
        // 同时也让document listener有效（fallback）
    }, 50);
    
    // 设置 document 级别粘贴监听器（作为fallback，textarea onpaste优先）
    window._equipModalPasteHandler = function(e) {
        var modal = document.getElementById('equip-photo-modal');
        if (!modal || modal.style.display !== 'flex') return;
        // 如果textarea已经处理过（通过其onpaste），跳过document级处理
        if (e.defaultPrevented) return;
        equipModalHandlePaste(e);
    };
    document.addEventListener('paste', window._equipModalPasteHandler);
};

// 关闭图片粘贴窗口
window.equipClosePhotoModal = function() {
    document.getElementById('equip-photo-modal').style.display = 'none';
    // 移除 document 级别粘贴监听器
    if (window._equipModalPasteHandler) {
        document.removeEventListener('paste', window._equipModalPasteHandler);
        delete window._equipModalPasteHandler;
    }
    _equipModalDataUrl = null;
    _equipModalCompressed = null;
    currentEquipmentPhotoIndex = null;
};

// 粘贴事件处理
window.equipModalHandlePaste = function(event) {
    event.preventDefault();
    event.stopPropagation();
    
    var clipboardData = event.clipboardData || (event.originalEvent && event.originalEvent.clipboardData);
    if (!clipboardData) {
        return;
    }
    
    for (var i = 0; i < clipboardData.items.length; i++) {
        var item = clipboardData.items[i];
        if (item.type.startsWith('image/')) {
            try {
                var file = item.getAsFile();
                if (file) {
                    equipModalLoadFile(file);
                }
            } catch(e) {
                console.error('[设备粘贴] 错误:', e);
                if (window.showToast) showToast('fa-solid fa-xmark', '粘贴图片失败: ' + e.message, 'error');
            }
            return;
        }
    }
    if (window.showToast) showToast('fa-solid fa-info-circle', '剪贴板中没有检测到图片，请截图或复制图片后按 Ctrl+V');
};



// 文件选择处理
window.equipModalHandleFileSelect = function(event) {
    var files = event.target.files;
    if (files && files.length > 0) {
        equipModalLoadFile(files[0]);
    }
    event.target.value = '';
};

// 加载图片文件到模态框
window.equipModalLoadFile = function(file) {
    if (file.size > 10 * 1024 * 1024) {
        if (window.showToast) showToast('fa-solid fa-exclamation-triangle', '图片不能超过10MB', 'error');
        return;
    }
    
    var reader = new FileReader();
    reader.onload = function(e) {
        _equipModalDataUrl = e.target.result;
        equipModalUpdatePreview();
    };
    reader.readAsDataURL(file);
};

// 更新预览（应用当前压缩质量设置）
window.equipModalUpdatePreview = function() {
    if (!_equipModalDataUrl) {
        document.getElementById('equip-photo-preview').style.display = 'none';
        return;
    }
    
    document.getElementById('equip-photo-preview').style.display = 'block';
    var previewImg = document.getElementById('equip-photo-preview-img');
    previewImg.src = _equipModalDataUrl;
    
    // 计算原始大小
    var origSize = Math.round(_equipModalDataUrl.length * 0.75 / 1024);
    document.getElementById('equip-photo-orig-size').innerText = origSize + 'KB';
    
    // 更新压缩质量显示
    var qSlider = document.getElementById('equip-photo-quality');
    var qLabel = document.getElementById('equip-photo-quality-label');
    if (qSlider && qLabel) {
        qLabel.innerText = Math.round(parseFloat(qSlider.value) * 100) + '%';
    }
    
    // 立即生成压缩预览
    equipModalCompressCurrent();
};

// 压缩当前图片并更新压缩后大小
window.equipModalCompressCurrent = function() {
    if (!_equipModalDataUrl) return;
    
    var qSlider = document.getElementById('equip-photo-quality');
    var quality = qSlider ? parseFloat(qSlider.value) : 0.35;
    
    equipCompressImageToDataUrl(_equipModalDataUrl, 150, quality).then(function(compressed) {
        _equipModalCompressed = compressed;
        var compSize = Math.round(compressed.length * 0.75 / 1024);
        document.getElementById('equip-photo-comp-size').innerText = compSize + 'KB';
        // 更新预览图显示压缩后的效果
        document.getElementById('equip-photo-preview-img').src = compressed;
    });
};

// 确认保存图片
window.equipModalSavePhoto = function() {
    if (currentEquipmentPhotoIndex === null || currentEquipmentPhotoIndex === undefined) {
        if (window.showToast) showToast('fa-solid fa-exclamation-triangle', '未选择设备点检行', 'error');
        return;
    }
    
    var toSave = _equipModalCompressed || _equipModalDataUrl;
    if (!toSave) {
        if (window.showToast) showToast('fa-solid fa-info-circle', '请先粘贴或上传图片');
        return;
    }
    
    if (!db || !db.sysDetail || !db.sysDetail.equipment || !db.sysDetail.equipment[currentEquipmentPhotoIndex]) {
        if (window.showToast) showToast('fa-solid fa-exclamation-triangle', '数据不存在，请刷新后重试', 'error');
        return;
    }
    
    db.sysDetail.equipment[currentEquipmentPhotoIndex].photo = toSave;
    if (window.triggerAutoSave) window.triggerAutoSave();
    if (typeof renderEquipmentTable === 'function') renderEquipmentTable();
    if (typeof renderSysOps === 'function') renderSysOps();
    equipClosePhotoModal();
    if (window.showToast) showToast('fa-solid fa-check-circle', '图片已添加');
};

// 增强版压缩函数（用于图片粘贴模态框）
window.equipCompressImageToDataUrl = function(dataUrl, maxWidth, quality) {
    return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() {
            var w = img.width, h = img.height;
            if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
            var canvas = document.createElement('canvas');
            canvas.width = Math.round(w);
            canvas.height = Math.round(h);
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = function() {
            // 加载失败时返回原始数据
            resolve(dataUrl);
        };
        img.src = dataUrl;
    });
};

// 更新 renderEquipmentTable 中的图片列：添加点击打开模态框的按钮
// 同时更新 equipHandlePaste 和 equipHandleDrop：改为打开模态框
window.equipHandlePaste = function(event, index) {
    event.preventDefault();
    event.stopPropagation();
    equipOpenPhotoModal(index);
};

window.equipHandleDrop = function(event, index) {
    event.preventDefault();
    equipOpenPhotoModal(index);
};

// ================= PSP 通报长图生成 (window.open + 逾期高亮) =================
console.log('[PSP诊断] 即将注册 generatePSPCompactReport...');
window.generatePSPCompactReport = function() {
    try {
        console.log('[PSP海报] 开始生成, showToast=' + (typeof showToast));
        
        var startInput = document.getElementById('psp-ai-start');
        var endInput = document.getElementById('psp-ai-end');
        
        if (!startInput || !endInput) {
            console.error('[PSP海报] 找不到日期输入框');
            if (window.showToast) showToast('fa-solid fa-exclamation-triangle', '找不到日期选择器', 'error');
            return;
        }
        
        var start = startInput.value;
        var end = endInput.value;
        
        if (!start || !end) {
            var today = new Date();
            var past7 = new Date();
            past7.setDate(today.getDate() - 7);
            start = past7.toISOString().split('T')[0];
            end = today.toISOString().split('T')[0];
            startInput.value = start;
            endInput.value = end;
        }
        
        var problems = [];
        // ★ 尝试1: 从 window.db 读取
        var dbData = window.db;
        console.log('[PSP海报] db.problems:', dbData ? (dbData.problems ? dbData.problems.length : 0) : 'null');
        if (dbData && dbData.problems && dbData.problems.length > 0) {
            problems = dbData.problems.filter(function(p) { return p.date >= start && p.date <= end; });
        }
        // ★ 尝试2: 如果 window.db 数据为空，从 localStorage 直接读取
        if (problems.length === 0) {
            try {
                var saved = localStorage.getItem('mbs_db');
                if (saved) {
                    var parsed = JSON.parse(saved);
                    if (parsed && parsed.problems && parsed.problems.length > 0) {
                        console.log('[PSP海报] 从 localStorage 获取到', parsed.problems.length, '条问题');
                        problems = parsed.problems.filter(function(p) { return p.date >= start && p.date <= end; });
                    }
                }
            } catch(e) {
                console.log('[PSP海报] localStorage 回退读取失败:', e);
            }
        }
        
        if (problems.length === 0) {
            console.log('[PSP海报] 无数据');
            if (window.showToast) showToast('fa-solid fa-info-circle', '所选时间段内暂无异常问题记录');
            return;
        }
        
        console.log('[PSP海报] 问题数:', problems.length);
        
        // 统计
        var totalP = problems.length;
        var solved = 0, inProg = 0, open = 0;
        var deptCount = {};
        var todayStr = new Date().toISOString().split('T')[0];
        var overdueCount = 0;
        
        problems.forEach(function(p) {
            var st = p.status || '未解决';
            if (st === '已解决' || st === 'Closed' || st === 'แก้ไขแล้ว') solved++;
            else if (st === '处理中' || st === 'In Prog' || st === 'กำลังทำ') inProg++;
            else open++;
            
            var d = p.dept || '其他';
            deptCount[d] = (deptCount[d] || 0) + 1;
            
            // 逾期判定: 有纳期 + 未解决/处理中 + 纳期 < 今天
            if (p.dueDate && (st === '未解决' || st === 'Open' || st === 'ยังไม่แก้' || st === '处理中' || st === 'In Prog' || st === 'กำลังทำ')) {
                if (p.dueDate < todayStr) overdueCount++;
            }
        });
        
        var closeRate = totalP > 0 ? ((solved / totalP) * 100).toFixed(1) : '0.0';
        
        // ====== 构建通报海报 HTML ======
        var h = '';
        h += '<div class="psp-poster">';
        
        // ★ 标题（中英双语）
        h += '<div class="psp-poster-hdr">';
        h += '<div class="psp-poster-title">📢 异常问题闭环通报<div class="bi-en-title">PSP Problem Close-Out Report</div></div>';
        h += '<div class="psp-poster-period">统计周期: ' + start + '  ~  ' + end + '&emsp;|&emsp;生成时间: ' + new Date().toLocaleString('zh-CN', {hour12:false}) + '<br><span class="bi-en-sub">Period: ' + start + ' ~ ' + end + ' | Generated: ' + new Date().toLocaleString('en-US', {hour12:false}) + '</span></div>';
        h += '</div>';
        
        // ★ 顶部概要条（中英双语）
        h += '<div class="psp-poster-summary-bar">';
        h += '<div class="psp-ps-item"><b>' + totalP + '</b><span class="bi-cn">问题总数</span><span class="bi-en">Total Problems</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#16a34a;">' + closeRate + '%</b><span class="bi-cn">闭环率</span><span class="bi-en">Close Rate</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#dc2626;">' + open + '</b><span class="bi-cn">未解决</span><span class="bi-en">Open</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#ea580c;">' + inProg + '</b><span class="bi-cn">处理中</span><span class="bi-en">In Progress</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#16a34a;">' + solved + '</b><span class="bi-cn">已解决</span><span class="bi-en">Closed</span></div>';
        h += '<div class="psp-ps-item" style="background:#fef2f2;"><b style="color:#dc2626;font-size:22px;">' + overdueCount + '</b><span class="bi-cn" style="color:#dc2626;">已逾期</span><span class="bi-en" style="color:#dc2626;">Overdue</span></div>';
        h += '</div>';
        
        // ★ 表格（中英双语表头）
        h += '<table class="psp-poster-table">';
        h += '<thead><tr>';
        h += '<th style="width:85px;"><div class="bi-th-cn">日期</div><div class="bi-th-en">Date</div></th>';
        h += '<th style="width:55px;"><div class="bi-th-cn">车间</div><div class="bi-th-en">Area</div></th>';
        h += '<th><div class="bi-th-cn">异常问题描述</div><div class="bi-th-en">Problem Description</div></th>';
        h += '<th style="width:72px;"><div class="bi-th-cn">责任部门</div><div class="bi-th-en">Dept</div></th>';
        h += '<th style="width:60px;"><div class="bi-th-cn">跟进人</div><div class="bi-th-en">PIC</div></th>';
        h += '<th style="width:85px;"><div class="bi-th-cn">纳期/完成时间</div><div class="bi-th-en">Due Date</div></th>';
        h += '<th style="width:62px;"><div class="bi-th-cn">状态</div><div class="bi-th-en">Status</div></th>';
        h += '<th style="width:85px;"><div class="bi-th-cn">逾期标记</div><div class="bi-th-en">Overdue Flag</div></th>';
        h += '</tr></thead><tbody>';
        
        // 排序：逾期优先 → 未解决 → 处理中 → 已解决
        problems.sort(function(a, b) {
            var aOv = (a.dueDate && a.dueDate < todayStr && a.status !== '已解决' && a.status !== 'Closed' && a.status !== 'แก้ไขแล้ว') ? 1 : 0;
            var bOv = (b.dueDate && b.dueDate < todayStr && b.status !== '已解决' && b.status !== 'Closed' && b.status !== 'แก้ไขแล้ว') ? 1 : 0;
            if (aOv !== bOv) return bOv - aOv;
            var aS = a.status === '已解决' || a.status === 'Closed' || a.status === 'แก้ไขแล้ว' ? 2 : (a.status === '处理中' || a.status === 'In Prog' || a.status === 'กำลังทำ' ? 1 : 0);
            var bS = b.status === '已解决' || b.status === 'Closed' || b.status === 'แก้ไขแล้ว' ? 2 : (b.status === '处理中' || b.status === 'In Prog' || b.status === 'กำลังทำ' ? 1 : 0);
            return aS - bS;
        });
        
        for (var i = 0; i < problems.length; i++) {
            var p = problems[i];
            var st = p.status || '未解决';
            var isSolved = (st === '已解决' || st === 'Closed' || st === 'แก้ไขแล้ว');
            var isOverdue = false;
            if (p.dueDate && !isSolved && p.dueDate < todayStr) isOverdue = true;
            
            var rowBg = isOverdue ? 'background:#fef2f2;' : (isSolved ? '' : '');
            var statusLabel = st;
            var statusStyle = isSolved ? 'color:#16a34a;font-weight:800;' : (st === '处理中' || st === 'In Prog' || st === 'กำลังทำ' ? 'color:#ea580c;font-weight:800;' : 'color:#dc2626;font-weight:800;');
            var overdueLabel = isOverdue ? '⚠️ 已逾期' : '';
            var overdueStyle = isOverdue ? 'background:#dc2626;color:#fff;font-weight:900;font-size:15px;padding:3px 8px;border-radius:4px;text-align:center;' : '';
            
            h += '<tr style="' + rowBg + '">';
            var shortDate = window.toShortDate ? window.toShortDate(p.date) : (p.date || '');
            var shortDue = window.toShortDate ? window.toShortDate(p.dueDate) : (p.dueDate || '');
            h += '<td>' + shortDate + '</td>';
            h += '<td>' + (p.ws || '') + '</td>';
            h += '<td style="text-align:left;word-break:break-word;font-size:13px;line-height:1.5;padding:5px 8px;">' + (p.desc || '') + '</td>';
            h += '<td>' + (p.dept || '') + '</td>';
            h += '<td>' + (p.owner || '') + '</td>';
            h += '<td>' + shortDue + '</td>';
                        var statusCN = (isSolved ? '已解决' : (st === '处理中' || st === 'In Prog' || st === 'กำลังทำ' ? '处理中' : '未解决'));
            var statusEN = (isSolved ? 'Closed' : (st === '处理中' || st === 'In Prog' || st === 'กำลังทำ' ? 'In Progress' : 'Open'));
            var statusGlow = isSolved ? 'text-shadow:0 0 8px rgba(22,163,74,0.6);' : (st === '处理中' || st === 'In Prog' || st === 'กำลังทำ' ? 'text-shadow:0 0 8px rgba(234,88,12,0.5);' : 'text-shadow:0 0 8px rgba(220,38,38,0.5);');
            h += '<td style="font-size:13px;font-weight:900;' + statusStyle + statusGlow + '"><span class="bi-cn" style="font-size:13px;font-weight:900;">' + statusCN + '</span><span class="bi-en" style="font-size:10px;font-weight:600;">' + statusEN + '</span></td>';
            h += '<td>' + (isOverdue ? '<div style="' + overdueStyle + '"><span class="bi-cn">⚠️ 已逾期</span><br><span class="bi-en" style="color:#fff;font-size:10px;">Overdue</span></div>' : '') + '</td>';
            h += '</tr>';
        }
        
        h += '</tbody></table>';
        
        // ★ 脚注（中英双语）
        h += '<div class="psp-poster-footer">';
        h += '逾期说明：纳期已过但状态仍未关闭的问题标记为红色「已逾期」，请责任部门尽快确认并处理。<br>';
        h += '<span class="bi-en-foot">Note: Items past due date and not yet closed are marked in red as "Overdue". Please confirm and take action ASAP.</span>';
        h += '</div>';
        
        h += '</div>'; // psp-poster 结束
        
        console.log('[PSP海报] HTML构建完成, 长度:', h.length);
        
        // ====== 打开新窗口展示 ======
        var win = window.open('', '_blank');
        if (!win) {
            console.log('[PSP海报] 弹窗被拦截');
            if (window.showToast) showToast('fa-solid fa-warning', '请允许弹窗以导出海报', 'error');
            return;
        }
        
        // 收集样式
        var styleHTML = '';
        var styles = document.querySelectorAll('style, link[rel="stylesheet"]');
        for (var si = 0; si < styles.length; si++) {
            styleHTML += styles[si].outerHTML;
        }
        
        win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PSP异常问题闭环通报 | PSP Problem Close-Out Report</title>');
        win.document.write(styleHTML);
        win.document.write('<style>' +
            'body{margin:0;padding:8px;background:#f8fafc;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:12px;}' +
            '.viewport,.sidebar,#particles-js,#drop-zone,.global-topbar,.page,.navbar,.card{display:none!important;}' +
            '@page{size:A4;margin:6mm;}' +
            '@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}' +
            '.psp-poster{width:960px;margin:0 auto;background:#fff;border-radius:6px;padding:16px;}' +
            '.psp-poster-hdr{text-align:center;padding-bottom:10px;border-bottom:3px solid #1e40af;margin-bottom:10px;}' +
            '.psp-poster-title{font-size:20px;font-weight:900;color:#1e3a5f;letter-spacing:1px;margin-bottom:2px;}' +
            '.bi-en-title{font-size:12px;font-weight:600;color:#64748b;letter-spacing:0;margin-top:1px;}' +
            '.bi-en-sub{font-size:11px;color:#94a3b8;font-weight:400;}' +
            '.bi-cn{display:block;font-size:10px;font-weight:700;line-height:1.3;}' +
            '.bi-en{display:block;font-size:9px;font-weight:500;color:#64748b;line-height:1.3;}' +
            '.bi-th-cn{font-size:11px;font-weight:800;line-height:1.3;}' +
            '.bi-th-en{font-size:9px;font-weight:500;line-height:1.3;opacity:0.85;}' +
            '.bi-en-foot{font-size:10px;color:#94a3b8;}' +
            '.psp-poster-period{font-size:11px;color:#64748b;font-weight:600;}' +
            '.psp-poster-summary-bar{display:flex;gap:8px;margin-bottom:12px;}' +
            '.psp-ps-item{flex:1;text-align:center;background:#f8fafc;border-radius:6px;padding:6px 4px;border:1px solid #e2e8f0;}' +
            '.psp-ps-item b{display:block;font-size:20px;font-weight:900;color:#1e293b;}' +
            '.psp-ps-item span{font-size:11px;font-weight:700;display:block;margin-top:2px;}' +
            '.psp-poster-table{width:100%;border-collapse:collapse;font-size:11px;}' +
            '.psp-poster-table thead th{background:#1e40af;color:#fff;padding:5px 8px;font-weight:900;font-size:13px;text-align:center;}' +
            '.psp-poster-table tbody td{padding:4px 8px;border-bottom:1px solid #e2e8f0;text-align:center;font-size:12px;}' +
            '.psp-poster-table tbody tr:nth-child(even) td{background:#f8fafc;}' +
            '.psp-poster-table tbody tr:hover td{background:#e8f0fe;}' +
            '.psp-poster-footer{text-align:center;font-size:10px;color:#94a3b8;margin-top:12px;padding-top:8px;border-top:1px solid #e2e8f0;}' +
            '</style></head><body>');
        win.document.write(h);
        win.document.write('</body></html>');
        win.document.close();
        
        console.log('[PSP海报] 新窗口已打开');
        if (window.showToast) showToast('fa-solid fa-file-image', '已生成PSP通报，可在打印窗口选择「另存为PDF」');
        setTimeout(function() {
            win.focus();
            win.print();
        }, 500);
        
    } catch(e) {
        console.error('[PSP海报] 生成失败:', e.message, e.stack);
        if (window.showToast) showToast('fa-solid fa-xmark', '海报生成失败: ' + e.message, 'error');
    }
};
