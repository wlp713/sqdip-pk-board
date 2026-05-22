        // ================= 核心架构与数据库 =================
        const DB_KEY = 'mbs_db_final_v40_pro';
        // ★ 全局 CLIENT_ID:确保两个脚本块使用相同的ID,防止云端同步回环
        window.CLIENT_ID = window.CLIENT_ID || Math.random().toString(36).substring(2, 10);
        const CLIENT_ID = window.CLIENT_ID;
        let db = { prod: {}, dm: {}, loss: [], problems: [], memo: '', dLinesConfig: { PRO1:[], PRO3:[], PRO4:[] }, sysOps: {}, sysDetail: { pre: [], mid: [] }, kaizen: [], targetMgmt: { targets: {}, dailyData: {} }, targetSettings: { workshops: {}, otherLines: {} } };
        window.db = db; // ★ 全局引用
        window.safeNum = window.safeNum || function(val) { const n = Number(val); return isNaN(n) ? 0 : n; };
        let isAppReady = false;
        let localSaveTimeout = null;
        let cloudSaveTimeout = null;
        let isCloudActive = false;
        let isFirebaseReady = false;
        let realtimeChannel = null;
        let localLastSaveTime = 0;

        // ★ 性能优化:数据变更标记,上次完整性检查后数据是否变化
        var _dataChangedSinceLastIntegrityCheck = true;

        // ================= Firebase 核心函数 =================
        // ★ 彻底修复:递归清理 db 中不合法的 Firebase key(非字符串/含.$#/[]等)
        // ★ 增强版:更严格的key检查,防止数据污染和保存失败
        function sanitizeForFirebase(obj, path) {
            if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
            if (Array.isArray(obj)) {
                obj.forEach(function(v, i) { obj[i] = sanitizeForFirebase(v, (path || '') + '[' + i + ']'); });
                return obj;
            }
            var keysToDelete = [];
            var keys = Object.keys(obj);
            for (var si = 0; si < keys.length; si++) {
                var k = keys[si];
                var currentPath = (path || 'root') + '.' + k;
                // 删除非字符串 key(如 HTMLInputElement 变成的 "[object HTMLInputElement]")
                if (typeof k !== 'string' || k === '') {
                    console.warn('[安全] 清理非字符串或空key:', k, 'at', currentPath, 'value:', JSON.stringify(obj[k]).substring(0, 100));
                    keysToDelete.push(k);
                } else if (/[\.#$\/\[\]]/.test(k) || /^\d+$/.test(k) || k.startsWith('__') || k.startsWith('_firebase')) {
                    // Firebase key不能包含 . # $ / [ ],不能是纯数字,不能以__或_firebase开头(内部保留)
                    console.warn('[安全] 清理非法字符key:', k, 'at', currentPath, 'value:', JSON.stringify(obj[k]).substring(0, 100));
                    keysToDelete.push(k);
                } else {
                    // 递归清理嵌套对象
                    obj[k] = sanitizeForFirebase(obj[k], currentPath);
                }
            }
            for (var sj = 0; sj < keysToDelete.length; sj++) {
                delete obj[keysToDelete[sj]];
            }
            return obj;
        }

        // 保存数据到 Firebase
        async function saveToFirebase() {
            if (!isFirebaseReady) {
                console.warn('[Firebase] 未就绪,跳过云端保存');
                return false;
            }
            try {
                // ★ 保存前确保数据完整性
                repairData();
                _dataChangedSinceLastIntegrityCheck = true;
                // ★ 深度清理所有不合法 key,确保 Firebase 保存永不失败
                sanitizeForFirebase(db, 'saveToFirebase');
                await window.firebaseSet(window.firebaseDbRef, {
                    db: db,
                    clientId: CLIENT_ID,
                    writeCounter: _localWriteCounter,
                    updatedAt: Date.now()
                });
                console.log('[Firebase] 云端保存成功 (counter=' + _localWriteCounter + ')');
                // ★ 方案4:保存成功Toast(3秒内不重复,避免自动保存刷屏)
                try {
                    if (Date.now() - (window._lastSaveToastTime || 0) > 3000) {
                        window._lastSaveToastTime = Date.now();
                        showToast('fa-solid fa-check-circle', '✓ 已保存', 'success');
                    }
                } catch(e) {}
                // ★ 同时更新 localStorage(含配额清理),防止下次加载旧数据
                try {
                    localStorage.setItem(DB_KEY, JSON.stringify(db));
                } catch(lsErr) {
                    console.warn('[saveToFirebase] localStorage写入失败,移除备份后重试');
                    try { localStorage.removeItem(DB_KEY + '_backup'); } catch(ex) {}
                    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e2) {
                        console.error('[saveToFirebase] localStorage写入仍然失败', e2.message);
                    }
                }
                return true;
            } catch(e) {
                console.error('[Firebase] 云端保存失败:', e);
                return false;
            }
        }

        // 从 Firebase 读取数据
        async function loadFromFirebase() {
            if (!isFirebaseReady) {
                console.warn('[Firebase] 未就绪,跳过云端读取');
                return null;
            }
            try {
                const snapshot = await window.firebaseGet(window.firebaseDbRef);
                if (snapshot.exists()) {
                    const data = snapshot.val();
                    // 只有当数据有效(db 存在且有内容)时才返回
                    if (data && data.db && Object.keys(data.db).length > 0) {
                        console.log('[Firebase] 云端读取成功');
                        return data;
                    }
                    console.log('[Firebase] 云端数据为空,跳过');
                    return null;
                }
                return null;
            } catch(e) {
                console.error('[Firebase] 云端读取失败:', e);
                return null;
            }
        }

        // 监听 Firebase 实时变化
        // ★ 记录本地最后一次写入的时间戳,防止 Firebase 缓存刷新导致的旧数据回写
        // ★ 本地写入计数器(持久化到 localStorage):每次成功写入后递增,解决 Firebase on('value') 缓存旧数据回滚问题
        //   时间戳方案有 race condition(on('value') 可能在计数器更新前触发),事件计数器方案会因页面刷新重置
        //   核心原理:计数器持久化到 localStorage,页面刷新后计数器值仍大于等于历史缓存数据中的计数器值,
        //           从而 on('value') 中的缓存数据(含已删条目)一律被忽略
        var _localWriteCounter = parseInt(localStorage.getItem('_firebaseWriteSeq') || '0');
        // ★ 诊断:记录计数器初始值
        console.log('[Firebase] 计数器初始化: ' + _localWriteCounter + ' (来自 localStorage)');

        // ★ 性能优化:延迟的 localStorage 写入,不阻塞 UI(JSON.stringify 大型 db 可能耗时>500ms)
        //   用于删除函数,让 UI 先渲染再同步到 localStorage
        var _pendingLocalSave = false;
        function _deferredLocalStorageSave() {
            if (_pendingLocalSave) return; // 同帧内多次触发只执行一次
            _pendingLocalSave = true;
            setTimeout(function() {
                _pendingLocalSave = false;
                try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e) {
                    console.warn('[deferredSave] localStorage保存失败', e);
                }
            }, 0);
        }

        // ★ saveToFirebase 包装:确保写入后持久化计数器
        var _origSaveToFirebase = saveToFirebase;
        saveToFirebase = async function() {
            var oldCounter = _localWriteCounter;
            _localWriteCounter++; // ★ 写入前递增计数器
            console.log('[Firebase] 开始保存, 计数器从 ' + oldCounter + ' 递增到 ' + _localWriteCounter);
            try {
                var result = await _origSaveToFirebase();
                if (result) {
                    // ★ 持久化到 localStorage,页面刷新后计数器值仍然正确
                    localStorage.setItem('_firebaseWriteSeq', String(_localWriteCounter));
                    console.log('[Firebase] 写入成功, 计数器=' + _localWriteCounter + ' (已持久化到 localStorage)');
                } else {
                    _localWriteCounter--; // ★ 失败则回滚计数器
                    console.warn('[Firebase] 保存失败, 计数器回滚到 ' + _localWriteCounter);
                }
                return result;
            } catch(e) {
                _localWriteCounter--; // ★ 异常则回滚计数器
                console.error('[Firebase] 保存异常, 计数器回滚到 ' + _localWriteCounter + ', 错误:', e.message);
                throw e;
            }
        };

        // ★ 强制立即保存(跳过防抖、计数器递增、直接推送云端),用于删除等关键操作
        // ★ 修复:检查 _origSaveToFirebase() 的返回值--它内部捕获异常返回 false,
        //   不是 throw,所以 catch 块抓不到!必须检查 result 是否为 true。
        window.forceSaveToFirebase = async function(maxRetries) {
            clearTimeout(cloudSaveTimeout);
            var oldCounter = _localWriteCounter;
            _localWriteCounter++; // ★ 写入前递增计数器,确保云端下发的旧缓存被忽略
            console.log('[forceSave] 开始强制保存, 计数器从 ' + oldCounter + ' 递增到 ' + _localWriteCounter);

            maxRetries = maxRetries || 3;
            var lastError = null;

            for (var attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    console.log('[forceSave] 尝试 ' + attempt + '/' + maxRetries);
                    // ★ 性能优化:不再在此处重复 sanitizeForFirebase,_origSaveToFirebase 内部已做

                    _dataChangedSinceLastIntegrityCheck = true;
                    // ★ 关键修复:_origSaveToFirebase 内部 catch 异常并返回 false,不是 throw
                    //   所以必须检查返回值,不能只依赖 catch 块
                    var saveResult = await _origSaveToFirebase();

                    if (saveResult !== true) {
                        // saveToFirebase 返回了 false(保存失败)
                        console.warn('[forceSave] 第' + attempt + '次尝试: _origSaveToFirebase 返回 ' + saveResult + '(非true),视为失败重试');
                        throw new Error('saveToFirebase 返回 ' + saveResult + ',保存未成功');
                    }

                    localStorage.setItem('_firebaseWriteSeq', String(_localWriteCounter));
                    console.log('[forceSave] 强制保存成功, 计数器=' + _localWriteCounter);
                    return true;
                } catch(e) {
                    lastError = e;
                    console.error('[forceSave] 第' + attempt + '次尝试失败:', e.message);

                    if (attempt < maxRetries) {
                        // 等待一会儿再重试
                        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    }
                }
            }

            // 所有重试都失败了
            _localWriteCounter--;
            console.error('[forceSave] 所有 ' + maxRetries + ' 次尝试都失败,计数器回滚到 ' + _localWriteCounter + ',最后错误:', lastError?.message || '未知');
            return false;
        };

        // ★ 数据完整性检查与自动修复
        function checkAndRepairDataIntegrity() {
            // ★ 性能优化:数据未变更则跳过完整性检查(减少低配设备GC压力)
            if (!_dataChangedSinceLastIntegrityCheck) {
                return;
            }
            _dataChangedSinceLastIntegrityCheck = false;
            console.log('[完整性检查] 开始检查数据完整性');
            var problems = [];

            // 检查loss数组
            if (!Array.isArray(db.loss)) {
                console.warn('[完整性检查] db.loss不是数组,修复为[]');
                db.loss = [];
                problems.push('loss修复为数组');
            }

            // 检查每个loss条目的完整性
            db.loss = db.loss.filter(function(item, index) {
                if (!item || typeof item !== 'object') {
                    console.warn('[完整性检查] 删除无效loss条目[' + index + ']');
                    problems.push('删除无效loss条目');
                    return false;
                }
                // 确保关键字段存在
                item.id = item.id || ('loss_' + Date.now() + '_' + index);
                return true;
            });

            // 检查prod对象
            if (!db.prod || typeof db.prod !== 'object') {
                console.warn('[完整性检查] db.prod不是对象,修复为{}');
                db.prod = {};
                problems.push('prod修复为对象');
            }

            // 检查dm对象
            if (!db.dm || typeof db.dm !== 'object') {
                console.warn('[完整性检查] db.dm不是对象,修复为{}');
                db.dm = {};
                problems.push('dm修复为对象');
            }

            if (problems.length > 0) {
                console.log('[完整性检查] 发现并修复了 ' + problems.length + ' 个问题:', problems.join(', '));
                // 立即保存修复后的数据
                setTimeout(function() {
                    saveToFirebase();
                }, 100);
            } else {
                console.log('[完整性检查] 数据完整性正常');
            }
        }

        // 每5分钟检查一次数据完整性
        setInterval(checkAndRepairDataIntegrity, 5 * 60 * 1000);

        function listenFirebaseRealtime() {
            if (!isFirebaseReady) return;
            var _mergeDebounceTimer = null;
            window.firebaseOnValue(window.firebaseDbRef, (snapshot) => {
                const data = snapshot.val();
                if (!data || !data.db || Object.keys(data.db).length === 0) {
                    console.log('[Firebase] 收到空数据或无db字段');
                    return;
                }
                var incomingCounter = data.writeCounter || 0;
                var clientId = data.clientId || 'unknown';

                // ★ 关键修复 (V2 - 写计数器):忽略 Firebase 缓存中非本次写入的数据
                //   场景:on('value') 在 set() 完成后先触发缓存旧数据(含已删条目),再触发真实新数据
                //   时间戳方案有 race condition(on('value') 可能在 _localWriteCounter 更新前触发)
                //   计数器方案:每次写入前 +1,on('value') 中 <= 本地计数器的数据一律忽略

                console.log('[Firebase] 收到更新: client=' + clientId + ', counter=' + incomingCounter + ', localCounter=' + _localWriteCounter);

                if (clientId === CLIENT_ID) {
                    // 同一个客户端:只忽略已见过的旧计数器
                    if (incomingCounter <= _localWriteCounter) {
                        console.log('[Firebase] 忽略同客户端缓存 (counter=' + incomingCounter + ' <= local=' + _localWriteCounter + ')');
                        console.log('[Firebase] 缓存内容摘要: keys=' + Object.keys(data.db).length + ', loss=' + (data.db.loss ? data.db.loss.length : 0) + ', problems=' + (data.db.problems ? data.db.problems.length : 0));
                        return;
                    }
                    console.log('[Firebase] 同客户端但计数器更新 (counter=' + incomingCounter + ' > local=' + _localWriteCounter + '),执行合并');
                } else {
                    console.log('[Firebase] 收到远程更新 (不同客户端, counter=' + incomingCounter + ')');
                }

                // ★ 性能优化:防抖合并,防止连续 on('value') 事件触发多次全量渲染
                if (_mergeDebounceTimer) clearTimeout(_mergeDebounceTimer);
                _mergeDebounceTimer = setTimeout(function() {
                    _mergeDebounceTimer = null;
                    console.log('[Firebase] 开始合并云端数据');
                    mergeCloudData(data.db);
                }, 200);
            });
        }

        // 合并云端数据到本地
        // ★ 智能深度合并:按ID合并数组,保留本地已有字段编辑
        // ★ 智能深度合并:按ID合并数组,保留本地已有字段编辑
        window.deepMergeArrayById = function(localArr, cloudArr) {
            if (!Array.isArray(cloudArr) || cloudArr.length === 0) return [];
            if (!Array.isArray(localArr)) localArr = [];
            // ★ 云端决定条目集合(cloud-authoritative),字段级深度合并保留本地编辑
            // ★ 删除能传播:云端没有的条目→本地也不会保留
            var cloudMap = {};
            var localMap = {};
            cloudArr.forEach(function(item) {
                if (item.id != null) cloudMap[String(item.id)] = item;
            });
            localArr.forEach(function(item) {
                if (item.id != null) localMap[String(item.id)] = item;
            });
            var result = [];
            // 遍历云端条目(决定存在性),有本地匹配时字段级合并
            cloudArr.forEach(function(cloudItem) {
                var cid = String(cloudItem.id);
                var localItem = localMap[cid];
                if (localItem) {
                    // 云端为基础,补充本地有而云端没有的临时字段(如_origDesc)
                    var merged = {};
                    Object.keys(cloudItem).forEach(function(k) { merged[k] = cloudItem[k]; });
                    Object.keys(localItem).forEach(function(k) {
                        if (cloudItem[k] === undefined && localItem[k] !== undefined) {
                            merged[k] = localItem[k];
                        }
                    });
                    result.push(merged);
                } else {
                    result.push(cloudItem);
                }
            });
            return result;
        };
        var deepMergeArrayById = window.deepMergeArrayById;
        function mergeCloudData(cloudDb) {
            if (!cloudDb || typeof cloudDb !== 'object') return;
            // ★ 深度清理云端数据中所有不合法 key,防止污染本地 db
            sanitizeForFirebase(cloudDb, 'mergeCloudData');
            // 只有当云端数据有效(非空)时才合并
            if (cloudDb.dLinesConfig && Object.keys(cloudDb.dLinesConfig).length > 0) db.dLinesConfig = cloudDb.dLinesConfig;
            if (cloudDb.problems && Array.isArray(cloudDb.problems)) {
                if (cloudDb.problems.length > 0) {
                    db.problems = deepMergeArrayById(db.problems || [], cloudDb.problems);
                }
            }
            if (cloudDb.loss && Array.isArray(cloudDb.loss)) {
                if (cloudDb.loss.length > 0) {
                    db.loss = deepMergeArrayById(db.loss || [], cloudDb.loss);
                } else {
                    db.loss = [];
                }
            }
            if (cloudDb.kaizen && Array.isArray(cloudDb.kaizen)) {
                if (cloudDb.kaizen.length > 0) {
                    db.kaizen = deepMergeArrayById(db.kaizen || [], cloudDb.kaizen);
                }
            }
            if (cloudDb.sysDetail && Object.keys(cloudDb.sysDetail).length > 0) {
                // ★ 深度合并 sysDetail：按类型逐级合并，保留本地已有删除标记等，不直接整体替换
                var deletedTypes = new Set();
                Object.keys(cloudDb.sysDetail).forEach(function(k) {
                    if (k === '_skipDates') { db.sysDetail._skipDates = cloudDb.sysDetail._skipDates; return; }
                    if (Array.isArray(cloudDb.sysDetail[k])) {
                        if (cloudDb.sysDetail[k].length > 0) {
                            db.sysDetail[k] = deepMergeArrayById(db.sysDetail[k] || [], cloudDb.sysDetail[k]);
                        } else {
                            // 云端有且为空数组 → 本地也该为空
                            db.sysDetail[k] = [];
                        }
                    }
                });
                // 确保本地不存在的类型也从云端拿到
                Object.keys(cloudDb.sysDetail).forEach(function(k) {
                    if (k !== '_skipDates' && !Array.isArray(db.sysDetail[k])) {
                        db.sysDetail[k] = Array.isArray(cloudDb.sysDetail[k]) ? cloudDb.sysDetail[k].slice() : cloudDb.sysDetail[k];
                    }
                });
            }
            if (cloudDb.memo !== undefined && cloudDb.memo !== null) db.memo = cloudDb.memo;
            if (cloudDb.prod && Object.keys(cloudDb.prod).length > 0) db.prod = cloudDb.prod;
            if (cloudDb.dm && Object.keys(cloudDb.dm).length > 0) db.dm = cloudDb.dm;
            if (cloudDb.sysOps && Object.keys(cloudDb.sysOps).length > 0) db.sysOps = cloudDb.sysOps;
            // ★ 保存到本地前也清理不合法 key(防止 localStorage 中也写入脏数据)
            sanitizeForFirebase(db, 'localStorageSave');
            try { try{localStorage.setItem(DB_KEY,JSON.stringify(db))}catch(qe){console.warn('[存储]配额满,移除备份后重试');try{localStorage.removeItem(DB_KEY+'_backup')}catch(ex){}try{localStorage.setItem(DB_KEY,JSON.stringify(db))}catch(qe2){}} } catch(e){}
            if (isAppReady) refreshAllViews();
        }

        // Firebase 就绪事件监听
        function _onFirebaseReady() {
            if (isFirebaseReady) return; // 防止重复执行
            isFirebaseReady = true;
            isCloudActive = true;
            console.log('[Firebase] 就绪事件触发');
            // 开始实时监听
            listenFirebaseRealtime();
            // 更新云端状态显示
            updateCloudStatus();
        }
        window.addEventListener('firebaseReady', _onFirebaseReady);
        // ★ 补偿:事件已在之前的脚本块中触发(先于本监听器注册)
        //   用 setTimeout(0) 推迟到整个脚本块执行完毕(此时 i18n 等 const 变量已初始化)
        if (window.isFirebaseReady) {
            setTimeout(_onFirebaseReady, 0);
        }

        // ★ 全局triggerAutoSave:脚本块1需要在全局作用域定义此函数
        // ★ 性能优化:快速编辑时跳过 localStorage 写入(仅保存最近一次)
        var _lastAutoSaveTime = 0;
        // ★ 内容哈希检测:数据未变化则跳过完整保存(老电脑性能优化)
        var _lastSerialized = '';
        window.triggerAutoSave = function() {
            try {
                // ★ 性能优化:1000ms 内触发多次时不重复执行完整保存流程
                var now = Date.now();
                var THROTTLE_MS = 1000;
                if (_lastAutoSaveTime > 0 && (now - _lastAutoSaveTime) < THROTTLE_MS) {
                    // 快速编辑:只更新云端防抖计时器,跳过 localStorage 写入
                    if (isFirebaseReady) {
                        clearTimeout(cloudSaveTimeout);
                        cloudSaveTimeout = setTimeout(function() {
                            saveToFirebase();
                        }, 3000);
                    }
                    return;
                }
                _lastAutoSaveTime = now;

                // 0. ★ 性能优化:只在必要时执行完整的 repairData (跳过已修复的旧数据)
                repairData();

                // ★ 性能优化:序列化一次,同时用于主保存和备份
                var _serialized;
                try { _serialized = JSON.stringify(db); } catch(_se) { _serialized = null; }
                if (!_serialized) return;

                // ★ 内容哈希:序列化内容未变则跳过 localStorage 写入
                if (_serialized === _lastSerialized) {
                    // 数据无变化,仅刷新保存指示器和云端同步
                    var _si = document.getElementById('save-indicator-text');
                    if(_si) _si.innerText = '已保存 at ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
                    if (isFirebaseReady) {
                        clearTimeout(cloudSaveTimeout);
                        cloudSaveTimeout = setTimeout(function() { saveToFirebase(); }, 3000);
                    }
                    return;
                }
                _lastSerialized = _serialized;

                // 1. 保存到 localStorage(主备份)
                try { localStorage.setItem(DB_KEY, _serialized); } catch(_se) {
                    // 配额不够 -> 删除唯一备份后重试
                    try {
                        try { localStorage.removeItem(DB_KEY + '_backup'); } catch(ex) {}
                        localStorage.setItem(DB_KEY, _serialized);
                    } catch(_se2) {}
                }

                // 2. 单轮换备份(始终覆盖同一个 key,不产生新 key)
                try { localStorage.setItem(DB_KEY + '_backup', _serialized); } catch(_be) {
                    // 配额不够且主 key 已安全保存,忽略即可
                }

                // 4. 更新保存指示器
                var _si = document.getElementById('save-indicator-text');
                if(_si) _si.innerText = '已保存 at ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});

                // 5. 云端同步(3s防抖,减少频繁输入时的保存开销)
                if (isFirebaseReady) {
                    clearTimeout(cloudSaveTimeout);
                    cloudSaveTimeout = setTimeout(function() {
                        saveToFirebase();
                    }, 3000);
                }

                console.log('数据已保存:', new Date().toLocaleTimeString());
            } catch(e){
                console.warn('[自动保存] 保存失败,尝试紧急清理:', e.message);
                try {
                    // 移除单轮换备份腾空间
                    try { localStorage.removeItem(DB_KEY + '_backup'); } catch(ex) {}
                    // 再试一次主力备份(复用已序列化的 _serialized)
                    if (_serialized) { localStorage.setItem(DB_KEY, _serialized); } else { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
                    console.log('[自动保存] 紧急清理后保存成功');
                } catch(e2) {
                    // db本身就超过5MB的极端情况 -> 只保存当前月份数据
                    console.warn('[自动保存] 主力备份也失败,尝试保存精简数据:', e2.message);
                    try {
                        var minDb = { meta: db.meta };
                        if (db.production) {
                            minDb.production = {};
                            var currentMonthKey = new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0');
                            for (var ws in db.production) {
                                if (db.production[ws] && db.production[ws][currentMonthKey]) {
                                    if (!minDb.production[ws]) minDb.production[ws] = {};
                                    minDb.production[ws][currentMonthKey] = db.production[ws][currentMonthKey];
                                }
                            }
                        }
                        localStorage.setItem(DB_KEY + '_minimal', JSON.stringify(minDb));
                        console.log('[自动保存] 精简数据已保存');
                    } catch(e3) {
                        console.error('[自动保存] 所有保存方式均失败:', e3.message);
                    }
                }
            }
        };
        const PRO_ORDER = ['PRO1', 'PRO2', 'PRO3', 'PRO4', 'H_MOTOR', 'F_MOTOR', 'S_MOTOR', 'CRANK'];
        const NEW_MOTOR_NAMES = { 'H_MOTOR': 'H电机线产出', 'F_MOTOR': 'F电机线产出', 'S_MOTOR': 'S系列电机线产出', 'CRANK': '曲轴线产出' };
        // 按照用户历史指令:加入 IP 与 QA 作为独立部门,以及 Pro.1-Pro.6
        const DEPTS = ['Pro.1', 'Pro.2', 'Pro.3', 'Pro.4', 'Pro.5', 'Pro.6', 'PE', 'HR', 'R&D', 'PC', 'IP', 'QA', 'PUR'];
        // ★ 统一AI分析系统提示词：所有分析类AI调用共享此设定
        // 不自我介绍，只做数据驱动分析，仅结尾可加一句建议
        const AI_ANALYSIS_SYSTEM = '你精通精益生产、生产管理、冰箱压缩机制造工艺，熟悉美的GMCC冰箱压缩机产品。\n\n规则：\n1. 不要自我介绍，不要提及"资深""专家""专业"等身份描述\n2. 只基于用户提供的现有数据进行分析\n3. 不得在分析过程中提任何建议或改善措施\n4. 仅在输出的最后一部分的结尾处，可以加一句话的建议\n5. 所有分析必须引用具体数字，严禁编造数据\n6. 输出专业简洁，以数据为导向';
        // ================= AI 极速引擎 (动态模型选择) =================
        const AI_URL = "https://api.siliconflow.cn/v1/chat/completions";
        const AI_KEY = "Bearer sk-pdmykhprsbiuskscwrnuwlhdvgfeomexwflenqbrfnvpwyqb";
        function _getPreferredModel() {
            var sel = document.getElementById('ai-model-selector');
            return sel ? sel.value : 'THUDM/GLM-4-9B-0414';
        }
        async function callAI_API(prompt, retryCount = 0, systemOverride, maxTokens) {
            try {
                var currentModel = _getPreferredModel();
                var msgs = [];
                if (systemOverride !== false) {
                    msgs.push({ "role": "system", "content": systemOverride || AI_ANALYSIS_SYSTEM });
                }
                msgs.push({ "role": "user", "content": prompt });
                var _mt = (typeof maxTokens === 'number' && maxTokens > 0) ? maxTokens : 512;
                const res = await fetch(AI_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': AI_KEY },
                    body: JSON.stringify({ model: currentModel, messages: msgs, temperature: 0.1, max_tokens: _mt })
                });
                const data = await res.json();
                if (!res.ok) {
                    if (res.status === 429 || (data.error && data.error.code === '429')) {
                        if (retryCount < 3) {
                            await new Promise(resolve => setTimeout(resolve, 1500 * (retryCount + 1)));
                            return await callAI_API(prompt, retryCount + 1, systemOverride);
                        } else throw new Error("服务器当前太拥挤,重试多次后依然失败,请稍后再试。");
                    }
                    throw new Error(data.error?.message || "API 错误");
                }
                let content = data.choices[0].message.content;
                return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            } catch(e) {
                console.error(e);
                showToast('fa-solid fa-xmark', 'AI 调用失败: ' + e.message, 'error');
                return null;
            }
        }
        // ================= 极速标准解析 (毫秒级) =================
        function showImportGuideAndOpenFile() {
            showToast('fa-solid fa-table', '请使用表头:ws,line,target,output,hours,att,head,date;PRO2线体填 LINE A-D', 'success');
            document.getElementById('importProdFile').click();
        }
        function splitSmartRow(line) {
            const cells = []; let curr = ''; let inQuote = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"') { inQuote = !inQuote; continue; }
                if (!inQuote && (ch === '\t' || ch === ',')) { cells.push(curr.trim()); curr = ''; continue; }
                curr += ch;
            }
            cells.push(curr.trim());
            return cells;
        }
        function normalizeImportHeader(h) {
            const key = String(h || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[()()%]/g, '');
            const map = {
                ws:'ws', workshop:'ws', area:'ws', pro:'ws', 车间:'ws', 制造单元:'ws', 线体单位:'ws',
                line:'line', 线体:'line', 产线:'line',
                target:'target', plan:'target', planned:'target', 计划:'target', 计划排产:'target', 排产:'target',
                output:'output', actual:'output', 实际:'output', 实际产出:'output', 产出:'output',
                hours:'hours', hour:'hours', h:'hours', 投入工时h:'hours', 投入工时:'hours', 工时:'hours',
                att:'att', attendance:'att', 出勤:'att', 出勤人数:'att',
                head:'head', headcount:'head', 绝对人数:'head', 在册人数:'head',
                date:'date', 日期:'date', 业务日期:'date'
            };
            return map[key] || key;
        }
        function applyProdImportRow(row, defaultDate) {
            const ws = String(row.ws || '').trim().toUpperCase();
            if (!PRO_ORDER.includes(ws)) return false;
            const dDate = row.date || defaultDate;
            ensureProdData(dDate);
            if (ws === 'PRO2' && row.line) {
                const lineKey = String(row.line).trim().toUpperCase().replace(/^LINE([A-D])$/, 'LINE $1');
                if (db.prod[dDate].PRO2.lines[lineKey]) {
                    if (row.target !== undefined) db.prod[dDate].PRO2.lines[lineKey].t = safeNum(row.target);
                    if (row.output !== undefined) db.prod[dDate].PRO2.lines[lineKey].o = safeNum(row.output);
                    if (row.hours !== undefined) db.prod[dDate].PRO2.lines[lineKey].h = safeNum(row.hours);
                    ['t','o','h'].forEach(f => { db.prod[dDate].PRO2[f] = Object.values(db.prod[dDate].PRO2.lines).reduce((sum, l) => sum + safeNum(l[f]), 0); });
                    return true;
                }
            }
            if (row.target !== undefined) db.prod[dDate][ws].t = safeNum(row.target);
            if (row.output !== undefined) db.prod[dDate][ws].o = safeNum(row.output);
            if (row.hours !== undefined) db.prod[dDate][ws].h = safeNum(row.hours);
            if (row.att !== undefined) db.prod[dDate][ws].att = safeNum(row.att);
            if (row.head !== undefined) db.prod[dDate][ws].head = safeNum(row.head);
            return true;
        }
        // ================= UPPH 格式极速解析(兼容月度各分厂产出工时导入) =================
        window.fastParseUPPH = function(rawText) {
            var lines = rawText.split(/\r?\n/).filter(function(l) { return l.trim(); });
            var currDate = window.safeDOM.val("globalDate");
            var count = 0;
            var inFactorySection = false;
            var currentWs = '';
            var dayMap = null; // { columnIndex: dayNumber }

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                var cols = line.split(/[\t,]+/).map(function(c) { return c.trim().replace(/,/g, '').replace(/%/g, ''); });
                if (cols.length < 2) continue;

                // 检测分厂区域开始
                if (line.indexOf('分厂 UPPH') >= 0 || line.indexOf('分厂UPPH') >= 0) {
                    inFactorySection = true;
                    dayMap = null; // 下一行是表头,重新建立映射
                    continue;
                }
                if (!inFactorySection) continue;

                // === 解析表头行(PRO, ,1日,2日,3日,...),建立列→日映射 ===
                if (dayMap === null) {
                    dayMap = {};
                    for (var c = 0; c < cols.length; c++) {
                        var match = cols[c].match(/^(\d{1,2})日$/);
                        if (match) {
                            dayMap[c] = parseInt(match[1], 10);
                        }
                    }
                    // 如果找到了日映射,这行就是表头,跳到下一行处理数据
                    if (Object.keys(dayMap).length > 0) continue;
                    // 没找到日映射(可能是标题行或其他),设空对象继续
                    dayMap = {};
                }

                // === 检测车间ID ===
                var first = cols[0].toUpperCase();
                if (first.match(/^PRO[1-4]$/)) {
                    currentWs = first;
                }
                if (!currentWs || !['PRO1','PRO2','PRO3','PRO4'].includes(currentWs)) continue;

                // === 检测行类型(扫描所有列,找到产出/工时标签) ===
                var rowType = '';
                for (var c = 0; c < cols.length; c++) {
                    var col = (cols[c] || '').trim();
                    if (col.indexOf('产出') >= 0 || col.indexOf('实际产出') >= 0 || col.indexOf('Output') >= 0) {
                        rowType = 'output';
                        break;
                    }
                    if (col.indexOf('工时') >= 0 || col.indexOf('工数') >= 0 || col.indexOf('Hours') >= 0 || col.indexOf('Hour') >= 0) {
                        rowType = 'hours';
                        break;
                    }
                    if (col.toUpperCase() === 'UPPH' || col === '效率') {
                        rowType = 'upph';
                        break;
                    }
                }
                // 跳过UPPH行(仅产出和工时写入db.prod)
                if (rowType !== 'output' && rowType !== 'hours') continue;

                // === 按日映射写入数据 ===
                var dayKeys = Object.keys(dayMap);
                for (var di = 0; di < dayKeys.length; di++) {
                    var c = parseInt(dayKeys[di], 10);
                    var dayNum = dayMap[c];
                    var val = parseFloat(cols[c]);
                    if (isNaN(val) || val <= 0) continue;
                    var dayStr = (dayNum < 10 ? '0' : '') + dayNum;
                    var fullDate = currDate.substring(0, 8) + dayStr;
                    ensureProdData(fullDate);
                    if (rowType === 'output') {
                        db.prod[fullDate][currentWs].o = val;
                    } else {
                        db.prod[fullDate][currentWs].h = val;
                    }
                    count++;
                }
            }
            return count;
        };

                                window.fastParseData = function() {
            let rawText = document.getElementById('pasteInput').value.trim();
            if(!rawText) return showToast('fa-solid fa-triangle-exclamation', '请先粘贴或拖入文件内容', 'warning');

            // ★ UPPH 格式自动检测(按分厂×日产出工时表导入)
            if (rawText.indexOf('UPPH') >= 0 && rawText.indexOf('达成') >= 0 && rawText.match(/PRO[1-4]/)) {
                let upphCount = fastParseUPPH(rawText);
                if (upphCount > 0) {
                    triggerAutoSave(); refreshAllViews();
                    showToast('fa-solid fa-bolt', 'UPPH 极速解析完成:共导入 ' + upphCount + ' 条数据');
                    document.getElementById('paste-modal').style.display = 'none';
                    return;
                }
            }

            let lines = rawText.split(/\r?\n/).filter(line => line.trim());
            let count = 0; let currDate = window.safeDOM.val("globalDate");
            ensureProdData(currDate);
            const firstCols = splitSmartRow(lines[0]).map(normalizeImportHeader);
            const hasHeader = firstCols.includes('ws') && (firstCols.includes('target') || firstCols.includes('output') || firstCols.includes('hours'));
            lines.forEach((line, idx) => {
                if (hasHeader && idx === 0) return;
                let cols = splitSmartRow(line);
                if (hasHeader) {
                    const row = {};
                    firstCols.forEach((key, i) => { if (key) row[key] = cols[i]; });
                    if (applyProdImportRow(row, currDate)) count++;
                    return;
                }
                if(cols.length >= 4) {
                    let ws = cols[0].toUpperCase();
                    if(PRO_ORDER.includes(ws)) {
                        // 修正名称格式识别: "LINE [Letter]"
                        if(ws === 'PRO2' && cols[1].toUpperCase().startsWith('LINE')) {
                           let lineName = cols[1].toUpperCase();
                           if(db.prod[currDate]['PRO2'].lines[lineName]) {
                               applyProdImportRow({ ws, line: lineName, target: cols[2], output: cols[3], hours: cols[4] }, currDate);
                               count++;
                           }
                        } else if(cols.length >= 5) {
                           applyProdImportRow({ ws, target: cols[1], output: cols[2], hours: cols[3], att: cols[4], head: cols[5] }, currDate);
                           count++;
                        }
                    }
                }
            });
            if(count>0) { triggerAutoSave(); refreshAllViews(); showToast('fa-solid fa-bolt', `极速解析完成:毫秒录入 ${count} 行数据`); document.getElementById('paste-modal').style.display='none'; }
            else { showToast('fa-solid fa-xmark', '未识别到标准格式,建议改用右侧 AI 智能提取', 'warning'); }
        };
        // ================= AI 智能托底提取 =================
        window.aiParseData = async function() {
            let rawText = document.getElementById('pasteInput').value.trim();
            if(!rawText) return showToast('fa-solid fa-triangle-exclamation', '请先粘贴或拖入文件内容', 'warning');

            // ★ UPPH 格式检测,优先走极速规则(不需要AI)
            if (rawText.indexOf('UPPH') >= 0 && rawText.indexOf('达成') >= 0 && rawText.match(/PRO[1-4]/)) {
                let upphCount = fastParseUPPH(rawText);
                if (upphCount > 0) {
                    triggerAutoSave(); refreshAllViews();
                    showToast('fa-solid fa-bolt', 'UPPH 极速解析完成:共导入 ' + upphCount + ' 条数据 (AI识别)');
                    document.getElementById('paste-modal').style.display = 'none';
                    return;
                }
            }

            let btn = document.getElementById('btn-ai-parse');
            let originalHtml = btn.innerHTML;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 处理中...`; btn.disabled = true;
            const prompt = `你是一个底层数据处理中间件。任务是将散乱输入精准映射为JSON格式。
            1. 车间(ws) 必须是 "PRO1", "PRO2", "PRO3", "PRO4"。
            2. 线体(line) 仅在 PRO2 有效,必须是 "LINE A", "LINE B", "LINE C", "LINE D"。
            3. 日期(date) YYYY-MM-DD,缺失留空。
            4. 纯数字字段:target, output, hours, att, head。
            仅输出 JSON 数组,例如:[{"date":"","ws":"","line":"","target":0,"output":0,"hours":0,"att":0,"head":0}]
            不要Markdown。数据:\n${rawText}`;
            let aiJsonStr = await callAI_API(prompt, 0, false); // data task, no system prompt
            btn.innerHTML = originalHtml; btn.disabled = false;
            if(aiJsonStr) {
                try {
                    let cleanJson = aiJsonStr.replace(/```json/gi, '').replace(/```/gi, '').trim();
                    let match = cleanJson.match(/\[[\s\S]*\]/);
                    if (match) cleanJson = match[0];
                    let parsedData = JSON.parse(cleanJson);
                    let count = 0; let currDate = window.safeDOM.val("globalDate");
                    parsedData.forEach(row => {
                        let dDate = row.date || currDate;
                        if(!dDate || !row.ws) return;
                        ensureProdData(dDate);
                        if(row.ws === 'PRO2' && row.line && ['LINE A','LINE B','LINE C','LINE D'].includes(row.line.toUpperCase())) {
                            let lineKey = row.line.toUpperCase();
                            if(row.target !== undefined) db.prod[dDate]['PRO2'].lines[lineKey].t = Number(row.target) || 0;
                            if(row.output !== undefined) db.prod[dDate]['PRO2'].lines[lineKey].o = Number(row.output) || 0;
                            if(row.hours !== undefined) db.prod[dDate]['PRO2'].lines[lineKey].h = Number(row.hours) || 0;
                            updateFixedLine('PRO2', lineKey, 't', db.prod[dDate]['PRO2'].lines[lineKey].t);
                            count++;
                        } else if (PRO_ORDER.includes(row.ws.toUpperCase())) {
                            let wsKey = row.ws.toUpperCase();
                            if(row.target !== undefined) db.prod[dDate][wsKey].t = Number(row.target) || 0;
                            if(row.output !== undefined) db.prod[dDate][wsKey].o = Number(row.output) || 0;
                            if(row.hours !== undefined) db.prod[dDate][wsKey].h = Number(row.hours) || 0;
                            if(row.att !== undefined) db.prod[dDate][wsKey].att = Number(row.att) || 0;
                            if(row.head !== undefined) db.prod[dDate][wsKey].head = Number(row.head) || 0;
                            count++;
                        }
                    });
                    if(count > 0) { triggerAutoSave(); refreshAllViews(); showToast('fa-solid fa-check', `AI 提取 ${count} 条数据`); document.getElementById('paste-modal').style.display='none'; }
                    else { showToast('fa-solid fa-xmark', '未提取到数据', 'warning'); }
                } catch(e) { showToast('fa-solid fa-xmark', 'AI解析错误', 'error'); }
            }
        };
        // ================= 📅 智能日期解析辅助函数 =================
        window.parseSmartDate = function(dateStr, contextDate) {
            if (!dateStr) return '';
            // DD/MM/YYYY 格式 (如 01/04/2026)
            let ddMMyyyy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
            if (ddMMyyyy) {
                let day = ddMMyyyy[1].padStart(2, '0');
                let month = ddMMyyyy[2].padStart(2, '0');
                let year = ddMMyyyy[3];
                return `${year}-${month}-${day}`;
            }
            // YYYY-MM-DD 格式
            if (dateStr.match(/^\d{4}-\d{1,2}-\d{1,2}$/)) {
                return dateStr;
            }
            // 相对日期
            let today = new Date();
            if (dateStr.includes('昨天') || dateStr.includes('yesterday') || dateStr.includes('เมื่อวาน')) {
                let yesterday = new Date(today);
                yesterday.setDate(yesterday.getDate() - 1);
                return yesterday.toISOString().split('T')[0];
            }
            if (dateStr.includes('今天') || dateStr.includes('today') || dateStr.includes('วันนี้')) {
                return today.toISOString().split('T')[0];
            }
            // 数字日期 (如 15号)
            let dayMatch = dateStr.match(/(\d{1,2})[号日]/);
            if (dayMatch) {
                let day = parseInt(dayMatch[1]);
                let year = today.getFullYear();
                let month = today.getMonth() + 1;
                // 如果今天是1号,但提到30号,可能是上个月
                if (day > today.getDate() + 7) {
                    month = month === 1 ? 12 : month - 1;
                }
                return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            }
            return contextDate || '';
        };
        // ================= 极速本地LOSS解析(纯规则,无AI) =================
        // 支持格式示例:
        // "01/05/2026 Day A 设备故障停机 PE -150"
        // "02/05/2026 Night B เครื่องเชื่อมรั่ว 150 Mr.Somchai"
        // "03/05/2026 D C พนักงานขาด 5 คน HR"
        function fastParseLoss(rawText) {
            const lines = rawText.split(/\n|\r|\r\n/).filter(l => l.trim());
            const results = [];

            // ========== 部门关键词库(中泰英,优先级从高到低) ==========
            const deptKeywords = {
                'PE': [
                    // 中文
                    '设备','故障','停机','维修','机械','电气','焊接','气密','泄漏','漏气','机器','压缩机','泵','电机','传感器','阀门','模具','工装','治具','夹具','报警','警报','断电','跳闸','螺丝','螺栓','轴承','皮带','链条','气缸','液压','气动','温控','冷媒','制冷','真空','压力','流量',
                    // 英文
                    'breakdown','machine','repair','weld','leak','compressor','motor','pump','valve','sensor','mold','tooling','fixture','alarm','power','trip','bearing','belt','chain','cylinder','hydraulic','pneumatic','temperature','pressure','vacuum','flow','equipment','electrical','mechanical','welding',
                    // 泰文
                    'มอเตอร์','เครื่องจักร','เสีย','ซ่อม','รั่ว','เชื่อม','หยุด','ไลน์เสีย','อุปกรณ์','เครื่องอัด','คอมเพรสเซอร์','เหล็ก','เฟือง','ลูกปืน','สายพาน','วาล์ว','เซ็นเซอร์','แม่พิมพ์','อุปกรณ์จับยึด','ไฟดับ','เตือน','ชิ้นส่วน','เครื่องซ่อม','ระบบ','หุ่นยนต์'
                ],
                'HR': [
                    // 中文
                    '人员','缺勤','离职','招聘','培训','纪律','缺人','员工','工人','请假','旷工','迟到','早退','加班','换岗','调动','工伤','请假','病假','事假','产假','年假','调休','排班','考勤','人事','人手','人力',
                    // 英文
                    'absent','operator','staff','training','employee','leave','sick','vacation','overtime','attendance','manpower','worker','resign','recruit','hr','personnel','labor','shift',
                    // 泰文
                    'พนักงาน','ขาดงาน','ลาออก','อบรม','ไม่มีคน','ลา','ลาป่วย','ลากิจ','ลาคลอด','ทํางานล่วงเวลา','เปลี่ยนกะ','ย้าย','บาดเจ็บ','ลาพักร้อน','เวลางาน','บุคลากร','แรงงาน','พักผ่อน','มาสาย','กลับก่อน'
                ],
                'PC': [
                    // 中文
                    '计划','排产','换型','换模','换产','物料','缺料','短缺','等待','备料','来料','齐套','缺件','欠料','断料','呆料','余料','退料','补料','领料','发料','投料','采购','供应商','交期','交货','送货','收货','仓库','库存','盘点','周转','齐套','配套','批次','批量','订单','客户需求','产能','负荷','排程','调度','瓶颈','节拍',
                    // 英文
                    'schedule','material','shortage','changeover','plan','wait','missing','stock','inventory','warehouse','supply','delivery','order','capacity','load','bottleneck','takt','logistics','procurement','vendor','parts','component','raw','wip','finished','batch','lot',
                    // 泰文
                    'แผน','ขาด','ไม่มี','ปลี่ยนรุ่น','รอ','จัดสรร','วัตถุดิบ','ขาดแคลน','จัดหาไม่ได้','คลัง','สต็อก','สั่งซื้อ','ส่งมอบ','ชิ้นส่วน','อะไหล่','เปลี่ยนแม่พิมพ์','รอวัสดุ','ไม่พร้อม','ครบชุด','ล็อต','ออเดอร์','กําลังการผลิต','เปลี่ยนผลิตภัณฑ์','เร่ง','ด่วน'
                ],
                'QA': [
                    // 中文
                    '品质','不良','缺陷','检验','NG','返工','质量','不合格','抽检','测试失败','外观','尺寸','性能','功能','可靠性','耐久性','一致性','偏差','变异','异常','超差','偏小','偏大','变形','划伤','碰伤','毛刺','异物','脏污','生锈','氧化','变色','裂纹','断裂','磨损','老化','失效','返修','报废','让步接收','特采','挑选','筛选','追溯','召回','客诉','投诉','索赔','赔偿','8D','纠正','预防','改进','改善',
                    // 英文
                    'quality','defect','inspect','rework','reject','ng','fail','test','appearance','dimension','performance','function','reliability','variation','deviation','error','abnormal','scratch','dent','burr','foreign','contamination','rust','oxidation','discoloration','crack','fracture','wear','aging','failure','scrap','concession','sort','trace','recall','complaint','claim','8d','corrective','preventive','improvement','qa','qc',
                    // 泰文
                    'คุณภาพ','ไม่ดี','ตรวจ','แก้ไข','สินค้าเสีย','NG','ไม่ผ่าน','ข้อบกพร่อง','ตรวจสอบ','ทดสอบ','ล้มเหลว','รูปลักษณ์','ขนาด','ประสิทธิภาพ','ความผิดปกติ','รอยขีดข่วน','รอยบุ๋ม','สนิม','รอยแตก','สึกหรอ','เสียหาย','ทิ้ง','คัดกรอง','ติดตาม','ร้องเรียน','ชดใช้','แก้ไขปัญหา','ป้องกัน','ปรับปรุง'
                ],
                'R&D': [
                    // 中文
                    '设计','研发','图纸','技术','工艺','参数','规格','变更','改进','优化','开发','试制','验证','认证','专利','知识产权','标准','规范','规程','指导书','SOP','WI','BOM','ECN','ECO','工程变更','技术支持','技术改造',
                    // 英文
                    'design','rd','r&d','drawing','process','parameter','spec','change','improvement','optimization','development','prototype','validation','certification','patent','standard','sop','wi','bom','ecn','eco','engineering','technical',
                    // 泰文
                    'ออกแบบ','พัฒนา','เทคโนโลยี','แบบ','สเปค','พารามิเตอร์','การเปลี่ยนแปลง','ปรับปรุง','พัฒนาผลิตภัณฑ์','ต้นแบบ','ทดสอบ','รับรอง','สิทธิบัตร','มาตรฐาน','คู่มือ','วิศวกรรม','เทคนิค'
                ],
                'IP': [
                    // 中文
                    '工程','设施','厂房','环境','能源','温度','湿度','电','水','气','压缩空气','照明','通风','空调','暖通','消防','安全','环保','排污','废水','废气','固废','噪音','振动','防静电','接地','配电','变压器','发电机','UPS','基建','装修','维护','保养','5S','目视化','标识','划线',
                    // 英文
                    'facility','environment','energy','temperature','humidity','electricity','water','air','compressed','lighting','ventilation','hvac','fire','safety','emission','waste','noise','vibration','esd','grounding','power','transformer','generator','ups','infrastructure','maintenance','5s','visual','labeling',
                    // 泰文
                    'โรงงาน','สิ่งแวดล้อม','ไฟ','น้ํา','อากาศ','อุณหภูมิ','ความชื้น','ระบบ','ปรับอากาศ','ระบายอากาศ','ไฟฟ้า','เครื่องกําเนิดไฟฟ้า','ปั๊มลม','แสงสว่าง','น้ําเสีย','ก๊าซเสีย','เสียง','ความปลอดภัย','ดับเพลิง','บํารุงรักษา','5S','ป้าย','เครื่องหมาย'
                ]
            };

            // 智能识别部门(根据关键词匹配度)
            function identifyDept(text) {
                const lowerText = (text || '').toLowerCase();
                let maxScore = 0;
                let bestDept = 'PE'; // 默认PE

                for (const [dept, keywords] of Object.entries(deptKeywords)) {
                    let score = 0;
                    for (const keyword of keywords) {
                        if (lowerText.includes(keyword.toLowerCase())) {
                            score++;
                            // 精确匹配加分
                            if (lowerText === keyword.toLowerCase()) score += 2;
                        }
                    }
                    if (score > maxScore) {
                        maxScore = score;
                        bestDept = dept;
                    }
                }
                return bestDept;
            }

            // ========== 线体识别规则(更灵活) ==========
            function identifyLine(text) {
                // LINE X 格式
                let match = text.match(/LINE\s*([A-Da-d])/i);
                if (match) return 'LINE ' + match[1].toUpperCase();
                // ไลน์ X 格式(泰语)
                match = text.match(/ไลน์\s*([A-Da-d])/i);
                if (match) return 'LINE ' + match[1].toUpperCase();
                // 单独的字母 A-D(前后有空格或边界)
                match = text.match(/(?:^|\s)([A-Da-d])(?:\s|$|,|;|-|\/)/);
                if (match) return 'LINE ' + match[1].toUpperCase();
                // 线体A、A线 等中文格式
                match = text.match(/线体?([A-Da-d])|([A-Da-d])线/);
                if (match) return 'LINE ' + (match[1] || match[2]).toUpperCase();
                // 默认LINE A
                return 'LINE A';
            }

            // ========== 班次识别规则(更灵活) ==========
            function identifyShift(text) {
                const lowerText = (text || '').toLowerCase();
                // 夜班关键词(多语言)
                const nightKeywords = ['night', '夜班', '晚班', 'n', 'ดึก', 'กลางคืน', 'night shift', 'กะกลางคืน', 'เวรค่ํา', '晚', 'nightshift'];
                for (const kw of nightKeywords) {
                    if (lowerText.includes(kw.toLowerCase())) {
                        // 排除Day/N格式中的N后面的其他内容
                        if (kw === 'n' && lowerText.includes('ng')) continue; // 排除英文单词中的n
                        return 'N';
                    }
                }
                // 白班关键词
                const dayKeywords = ['day', '白班', '日班', 'd', 'กลางวัน', 'day shift', 'กะกลางวัน', 'เวรเช้า', '早', 'dayshift'];
                for (const kw of dayKeywords) {
                    if (lowerText.includes(kw.toLowerCase())) {
                        return 'D';
                    }
                }
                // 默认白班
                return 'D';
            }

            // ========== 日期识别规则(更灵活) ==========
            function identifyDate(text, contextDate) {
                // DD/MM/YYYY 格式(最常见)
                let match = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
                if (match) {
                    const day = match[1].padStart(2, '0');
                    const month = match[2].padStart(2, '0');
                    const year = match[3];
                    return `${year}-${month}-${day}`;
                }
                // YYYY-MM-DD 格式
                match = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
                if (match) return match[0];
                // YYYY/MM/DD 格式
                match = text.match(/\b(\d{4})\/(\d{2})\/(\d{2})\b/);
                if (match) return match[0].replace(/\//g, '-');
                // MM-DD-YYYY 或 MM/DD/YYYY 格式
                match = text.match(/\b(\d{2})[-\/](\d{2})[-\/](\d{4})\b/);
                if (match) {
                    const month = match[1];
                    const day = match[2];
                    const year = match[3];
                    return `${year}-${month}-${day}`;
                }
                // 相对日期
                const today = new Date();
                if (/昨天|yesterday|เมื่อวาน/i.test(text)) {
                    today.setDate(today.getDate() - 1);
                    return today.toISOString().split('T')[0];
                }
                if (/今天|today|วันนี้/i.test(text)) {
                    return today.toISOString().split('T')[0];
                }
                if (/明天|tomorrow|พรุ่งนี้/i.test(text)) {
                    today.setDate(today.getDate() + 1);
                    return today.toISOString().split('T')[0];
                }
                // 数字+号/日 格式(如 15号、15日)
                match = text.match(/(\d{1,2})[号日]/);
                if (match) {
                    const day = parseInt(match[1]).toString().padStart(2, '0');
                    const year = today.getFullYear();
                    const month = (today.getMonth() + 1).toString().padStart(2, '0');
                    return `${year}-${month}-${day}`;
                }
                // 如果没有找到日期,使用当前日期
                return contextDate || new Date().toISOString().split('T')[0];
            }

            // ========== 数量识别规则(更灵活) ==========
            function identifyQty(text) {
                // 移除日期中的数字,避免干扰
                let cleanText = text
                    .replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '')
                    .replace(/\d{4}-\d{2}-\d{2}/g, '')
                    .replace(/\d{4}\/\d{2}\/\d{2}/g, '');

                // 匹配所有数字(包括负数)
                const numbers = cleanText.match(/-?\d{1,6}/g);
                if (numbers) {
                    // 过滤掉可能的日期数字(1-31之间且单独出现)
                    const validNumbers = numbers.map(n => parseInt(n)).filter(n => Math.abs(n) > 31 || n < 0);
                    if (validNumbers.length > 0) {
                        let qty = validNumbers[validNumbers.length - 1];
                        if (qty > 0) qty = -qty; // 转为负数
                        return qty;
                    }
                    // 如果只有小数字,取最后一个
                    let qty = parseInt(numbers[numbers.length - 1]);
                    if (qty > 0) qty = -qty;
                    return qty;
                }
                return 0;
            }

            // ========== 负责人识别规则 ==========
            function identifyOwner(text) {
                // Mr.xxx 格式
                let match = text.match(/Mr\.?\s*([A-Za-z]+)/i);
                if (match) return 'Mr.' + match[1];
                // 泰语称呼
                match = text.match(/(นาย|คุณ)\s*([\u0E00-\u0E7F]+)/);
                if (match) return match[1] + match[2];
                // 中文名(2-4个中文字符)
                match = text.match(/[\u4e00-\u9fa5]{2,4}/);
                if (match && !text.includes(match[0] + '部')) return match[0];
                return '';
            }

            // ========== 显式部门识别(文本中直接出现的部门名称) ==========
            function identifyExplicitDept(text) {
                const upperText = text.toUpperCase();
                // 直接匹配部门代码(包括 Pro.1-Pro.6 格式)
                const deptPatterns = [
                    { pattern: /\bPro\.?1\b/i, code: 'Pro.1' },
                    { pattern: /\bPro\.?2\b/i, code: 'Pro.2' },
                    { pattern: /\bPro\.?3\b/i, code: 'Pro.3' },
                    { pattern: /\bPro\.?4\b/i, code: 'Pro.4' },
                    { pattern: /\bPro\.?5\b/i, code: 'Pro.5' },
                    { pattern: /\bPro\.?6\b/i, code: 'Pro.6' },
                    { pattern: /\bPE\b/i, code: 'PE' },
                    { pattern: /\bHR\b/i, code: 'HR' },
                    { pattern: /\bPC\b/i, code: 'PC' },
                    { pattern: /\bQA\b/i, code: 'QA' },
                    { pattern: /\bR&D\b/i, code: 'R&D' },
                    { pattern: /\bIP\b/i, code: 'IP' }
                ];
                for (const { pattern, code } of deptPatterns) {
                    if (pattern.test(text)) {
                        return code;
                    }
                }
                return null;
            }

            // ========== 主解析循环 ==========
            const currentDate = document.getElementById('globalDate')?.value || new Date().toISOString().split('T')[0];

            lines.forEach((line, idx) => {
                line = line.trim();
                if (!line || line.length < 5) return; // 太短则跳过

                // 1. 识别日期
                const date = identifyDate(line, currentDate);

                // 2. 识别班次(在移除日期之前)
                const shift = identifyShift(line);

                // 3. 识别线体
                const lineVal = identifyLine(line);

                // 4. 识别显式部门
                const explicitDept = identifyExplicitDept(line);

                // 5. 识别负责人
                const owner = identifyOwner(line);

                // 6. 识别数量(最后面的数字)
                const qty = identifyQty(line);

                // 7. 提取描述(按顺序移除已识别的部分)
                let desc = line;
                // 移除日期
                desc = desc.replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\d{4}\/\d{2}\/\d{2}/g, '');
                // 移除班次关键词
                desc = desc.replace(/\b(Day|Night|D|N|日班|夜班|白班|晚班|กลางวัน|ดึก|กลางคืน|dayshift|nightshift)\b/gi, '');
                // 移除线体(单独的字母A-D)
                desc = desc.replace(/\s([A-Da-d])\s/g, ' ');
                // 移除负责人
                desc = desc.replace(/Mr\.?\s*[A-Za-z]+/gi, '').replace(/(นาย|คุณ)\s*[\u0E00-\u0E7F]+/g, '');
                // 移除部门代码(包括 Pro.1-Pro.6 格式)
                desc = desc.replace(/\b(Pro\.?[1-6]|PE|HR|PC|QA|R&D|IP)\b/gi, '');
                // 移除最后的数字(LOSS数量)
                desc = desc.replace(/\s-?\d{1,6}\s*$/g, '');
                // 清理多余空格和标点
                desc = desc.replace(/\s+/g, ' ').replace(/^[,;\-:\s]+|[,;\-:\s]+$/g, '').trim();

                // 8. 智能识别部门(如果显式部门不存在,则根据描述内容识别)
                const dept = explicitDept || identifyDept(desc + ' ' + line);

                // 9. 验证并添加记录
                if (desc && desc.length >= 2) {
                    results.push({
                        id: Date.now() + idx + Math.random(),
                        date: date,
                        line: lineVal,
                        shift: shift,
                        desc: desc,
                        qty: qty,
                        owner: owner,
                        dept: dept
                    });
                }
            });

            return results;
        }

        window.aiParseLoss = async function() {
            let rawText = document.getElementById('lossPasteInput').value.trim();
            if(!rawText) return showToast('fa-solid fa-triangle-exclamation', '请先粘贴文本内容', 'warning');

            // 使用本地极速解析(不需要AI)
            const fastResults = fastParseLoss(rawText);
            if (fastResults.length > 0) {
                let count = 0;
                if(!db.loss) db.loss = [];
                fastResults.forEach(row => {
                    db.loss.unshift(row);
                    count++;
                });
                triggerAutoSave();
                renderLoss();
                showToast('fa-solid fa-bolt', `本地解析导入 ${count} 条LOSS`, 'success');
                document.getElementById('loss-ai-modal').style.display='none';
                return;
            }

            // 如果没有解析出结果,给出提示
            showToast('fa-solid fa-info-circle', '未能识别有效LOSS记录,请检查格式:日期(DD/MM/YYYY) + 班次 + 线体 + 描述 + 数量', 'warning');
        };
        // ================= 系统运作逻辑 (完全自治计算) =================
        function ensureSysData(date) {
            if(!db.sysOps[date]) db.sysOps[date] = { m4: 100, insp: 100, andon: 5, memo: '', locked: false };
            if(!db.sysDetail) db.sysDetail = { pre: [], mid: [], equipment: [] };
            if(!db.sysDetail.pre) db.sysDetail.pre = [];
            if(!db.sysDetail.mid) db.sysDetail.mid = [];
            if(!db.sysDetail.equipment) db.sysDetail.equipment = [];
        }
        window.updateSysOps = function() {
            let date = window.safeDOM.val("globalDate");
            db.sysOps[date].m4 = Number(document.getElementById('sys-4m').value)||0;
            db.sysOps[date].insp = Number(document.getElementById('sys-insp').value)||0;
            db.sysOps[date].andon = Number(document.getElementById('sys-andon').value)||0;
            db.sysOps[date].memo = document.getElementById('sys-memo').value;
            triggerAutoSave();
        };
        window.toggleSysLock = function() {
            let date = window.safeDOM.val("globalDate");
            db.sysOps[date].locked = !db.sysOps[date].locked;
            triggerAutoSave(); renderSysOps();
            showToast('fa-solid fa-lock', db.sysOps[date].locked ? '记录已硬锁定,底层防篡改生效' : '记录已解锁');
        };
        function renderSysOps() {
            let date = window.safeDOM.val("globalDate");
            ensureSysData(date);
            let currMonth = date.substring(0, 7);

            // ══════════ 事中:过程响应(来自事中记录 sysDetail.mid) ══════════
            let midRows = (db.sysDetail.mid || []).filter(r => String(r.date||'').startsWith(currMonth));
            let midCount = midRows.length;
            let avgResp = midCount > 0 ? (midRows.reduce((s,r) => s + safeNum(r.responseMin), 0) / midCount) : 0;
            let totalStopLoss = midRows.reduce((s,r) => s + Math.abs(safeNum(r.impactQty)), 0);
            let totalWaitMin = midRows.reduce((s,r) => s + safeNum(r.waitMin), 0);
            let patrolOk = midRows.filter(r => r.patrol && r.patrol.trim() !== '').length;
            let qualityIssues = midRows.filter(r => r.event && (r.event.includes('品质') || r.event.includes('质量') || r.event.includes('Quality') || r.event.includes('คุณภาพ'))).length;
            // 过程管控评分:响应越快、损失越小、巡检覆盖越多分越高
            let midScore = Math.min(100, Math.round(
                (avgResp <= 3 ? 40 : avgResp <= 8 ? 30 : avgResp <= 15 ? 20 : 10) +
                (totalStopLoss <= 10 ? 30 : totalStopLoss <= 50 ? 20 : 10) +
                (midCount > 0 ? Math.round(patrolOk/midCount*30) : 15)
            ));
            document.getElementById('sys-mid-andon').innerText = avgResp.toFixed(1) + '分';
            document.getElementById('sys-mid-stoploss').innerText = totalStopLoss;
            document.getElementById('sys-mid-quality').innerText = qualityIssues + '件';
            document.getElementById('sys-mid-patrol').innerText = patrolOk + '条';
            document.getElementById('sys-mid-bar').style.width = midScore + '%';
            document.getElementById('sys-mid-pct').innerText = midScore + '分';
            document.getElementById('sys-mid-wait').innerText = totalWaitMin + '分';
            document.getElementById('sys-mid-count').innerText = midCount;
            // ══════════ 事后：闭环与复盘 ══════════
            // ★ 闭环率改为 DM每日打卡完成率 ★
            var _dmPunchRows = (db.sysDetail && db.sysDetail.post || []).filter(function(r) { return r.type === 'dm_punch' && String(r.date||'').startsWith(currMonth); });
            var _dmPunchTotal = _dmPunchRows.length;
            var _dmPunchDone = _dmPunchRows.filter(function(r) { return r.dmDone === true; }).length;
            var closeRate = _dmPunchTotal > 0 ? Math.round(_dmPunchDone / _dmPunchTotal * 100) : 100;
            
            // ★ LOSS重复发生率（自动统计+周对比+同比）★
            var _monthLosses = (db.loss || []).filter(function(l) { return String(l.date||'').startsWith(currMonth); });
            var _lossDescMap = {}; var _repeatEvents = 0;
            _monthLosses.forEach(function(l) { if(l.desc) { var key = String(l.desc||'').trim().slice(0,40); _lossDescMap[key] = (_lossDescMap[key]||0) + 1; } });
            var _repeatBuckets = 0;
            for(var _k in _lossDescMap) { if(_lossDescMap[_k] > 1) { _repeatBuckets++; _repeatEvents += _lossDescMap[_k]; } }
            var repeatRate = _monthLosses.length > 0 ? Math.round(_repeatEvents / _monthLosses.length * 100) : 0;
            var repeatEvents = _repeatEvents;
            // ★ 周度重复率（本周 vs 上周）
            var _todayParts = window.safeDOM.val("globalDate").split('-');
            var _todayNum = parseInt(_todayParts[2]) || 15;
            var _thisWeekLoss = _monthLosses.filter(function(l){ var d=parseInt(String(l.date||'').substring(8,10))||0; return d > _todayNum-7 && d <= _todayNum; });
            var _lastWeekLoss = _monthLosses.filter(function(l){ var d=parseInt(String(l.date||'').substring(8,10))||0; return d > _todayNum-14 && d <= _todayNum-7; });
            var _twMap = {}, _twRep = 0; _thisWeekLoss.forEach(function(l){ if(l.desc){var k=String(l.desc).trim().slice(0,40); _twMap[k]=(_twMap[k]||0)+1;} }); for(var _tk in _twMap){if(_twMap[_tk]>1)_twRep+=_twMap[_tk];}
            var _lwMap = {}, _lwRep = 0; _lastWeekLoss.forEach(function(l){ if(l.desc){var k=String(l.desc).trim().slice(0,40); _lwMap[k]=(_lwMap[k]||0)+1;} }); for(var _lk in _lwMap){if(_lwMap[_lk]>1)_lwRep+=_lwMap[_lk];}
            var _twRate = _thisWeekLoss.length>0?Math.round(_twRep/_thisWeekLoss.length*100):0;
            var _lwRate = _lastWeekLoss.length>0?Math.round(_lwRep/_lastWeekLoss.length*100):0;
            var _wkChange = _lwRate>0?(_twRate-_lwRate):0;
            // DM开展率 — db.dm 是对象 { '2026-05-03': { PRO1: {am,pm}, ... }, ... }
            let dmObj = db.dm || {};
            let dmDates = Object.keys(dmObj).filter(k => k.startsWith(currMonth));
            let dmTotalSessions = 0, dmActualSessions = 0;
            dmDates.forEach(k => {
                let dayData = dmObj[k];
                Object.keys(dayData).forEach(ws => {
                    dmTotalSessions += 2; // am + pm
                    if(dayData[ws].am) dmActualSessions++;
                    if(dayData[ws].pm) dmActualSessions++;
                });
            });
            let dmRate = dmTotalSessions > 0 ? Math.round(dmActualSessions / dmTotalSessions * 100) : 0;
            // Kaizen改善提案数（优先从事后模块的改善项目记录读取，兼容旧db.kaizen）
            var _impRows = (db.sysDetail && db.sysDetail.post || []).filter(function(r) { return r.type === 'improvement' && String(r.date||'').startsWith(currMonth); });
            var kaizenCount = _impRows.length > 0 ? _impRows.length : (db.kaizen || []).filter(function(r) { return String(r.date||'').startsWith(currMonth); }).length;
            // 黑洞问题数（LOSS重复>=3的问题族）
            var blackHole = 0;
            for(var _kk in _lossDescMap) { if(_lossDescMap[_kk] >= 3) blackHole++; }
            // 事后综合分：闭环率40% + 无重复率30% + DM开展率20% + 改善提案10%
            let postScore = Math.min(100, Math.round(
                closeRate * 0.4 +
                (100 - repeatRate) * 0.3 +
                dmRate * 0.2 +
                Math.min(100, kaizenCount * 10) * 0.1
            ));
            document.getElementById('sys-post-close').innerText = closeRate + '%';
            document.getElementById('sys-post-repeat').innerText = repeatRate + '%';
            document.getElementById('sys-post-dm').innerText = dmRate + '%';
            document.getElementById('sys-post-kaizen').innerText = kaizenCount + '件';
            document.getElementById('sys-post-bar').style.width = postScore + '%';
            document.getElementById('sys-post-pct').innerText = postScore + '分';
            document.getElementById('sys-post-blackhole').innerText = blackHole;
            document.getElementById('sys-post-repeat-count').innerText = repeatEvents;
            
            // ══════════ 设备点检：KPI更新（修复：主页面小窗不同步） ══════════
            var equipRows = (db.sysDetail.equipment || []).filter(function(r) { return String(r.date||'').startsWith(currMonth); });
            var equipTotal = equipRows.length;
            var equipChecked = equipRows.filter(function(r) { return r.checked === true; }).length;
            var equipRate = equipTotal > 0 ? Math.round(equipChecked / equipTotal * 100) : 0;
            var equipPhotos = equipRows.filter(function(r) { return r.photo && String(r.photo).length > 100; }).length;
            // 本周点检率（当前ISO周）
            var now = new Date();
            var dayOfWeek = now.getDay(); // 0=Sun
            var diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
            var monday = new Date(now);
            monday.setDate(now.getDate() + diffToMonday);
            var weekRows = equipRows.filter(function(r) {
                if (!r.date) return false;
                var d = new Date(r.date);
                return d >= new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()) && d <= now;
            });
            var weekTotal = weekRows.length;
            var weekChecked = weekRows.filter(function(r) { return r.checked === true; }).length;
            var weekRate = weekTotal > 0 ? Math.round(weekChecked / weekTotal * 100) : 0;
            var todayStr = window.safeDOM.val('globalDate');
            var todayRows = equipRows.filter(function(r) { return String(r.date||'') === todayStr; });
            var todayChecked = todayRows.some(function(r) { return r.checked === true; });
            // 已配图、已打卡数量作为异常设备/完好率代理指标
            var faultCount = equipTotal - equipChecked;
            
            var el;
            el = document.getElementById('sys-equip-week'); if (el) el.innerText = (weekTotal > 0 ? weekRate : '--') + '%';
            el = document.getElementById('sys-equip-month'); if (el) el.innerText = equipRate + '%';
            el = document.getElementById('sys-equip-fault'); if (el) el.innerText = faultCount + '台';
            el = document.getElementById('sys-equip-today'); if (el) el.innerText = todayChecked ? '✅' : (todayRows.length > 0 ? '❌' : '--');
            el = document.getElementById('sys-equip-bar'); if (el) el.style.width = equipRate + '%';
            el = document.getElementById('sys-equip-pct'); if (el) el.innerText = equipRate + '%';
            el = document.getElementById('sys-equip-photos'); if (el) el.innerText = equipPhotos;
            el = document.getElementById('sys-equip-count'); if (el) el.innerText = equipTotal + '项';
        }

        // ================= 设备点检/事前事中预设数据函数 (从combined.html迁移) =================
        function equipGetYear() {
            var monthFromSelect = document.getElementById('equip-month-select');
            if (monthFromSelect) {
                var m = parseInt(monthFromSelect.value) || (new Date().getMonth() + 1);
                var year = new Date().getFullYear();
                return year;
            }
            return new Date().getFullYear();
        }
        function equipGetMonthStr() {
            var monthSelect = document.getElementById('equip-month-select');
            var m = monthSelect ? parseInt(monthSelect.value) : (new Date().getMonth() + 1);
            var year = new Date().getFullYear();
            return year + '-' + (m < 10 ? '0' + m : m);
        }
        function equipGetMonthNum() {
            var monthSelect = document.getElementById('equip-month-select');
            return monthSelect ? parseInt(monthSelect.value) : (new Date().getMonth() + 1);
        }
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
            var skipDates = db.sysDetail._skipDates && db.sysDetail._skipDates[type] ? db.sysDetail._skipDates[type] : {};
            var existingDates = {};
            db.sysDetail[type].forEach(function(r) {
                if (r && r.date && String(r.date || '').startsWith(month)) {
                    existingDates[r.date] = true;
                }
            });
            for (var day = 1; day <= daysInMonth; day++) {
                var dateStr = month + '-' + (day < 10 ? '0' + day : day);
                if (existingDates[dateStr]) continue;
                if (skipDates[dateStr]) continue;
                var record;
                if (type === 'pre') {
                    record = {
                        id: Date.now() + Math.random() + Math.random(),
                        date: dateStr, ws: 'PRO2', ownerDept: 'PRO2', line: 'LINE A',
                        equipment: '', item: '', issue: '', resp: '', status: '未完成'
                    };
                } else if (type === 'mid') {
                    record = {
                        id: Date.now() + Math.random() + Math.random(),
                        date: dateStr, ws: 'PRO2', line: 'LINE A', event: '',
                        responseMin: 0, waitMin: 0, impactQty: 0, patrol: '', action: '', resp: '', status: '已关闭'
                    };
                } else if (type === 'equipment') {
                    record = {
                        id: Date.now() + Math.random() + Math.random(),
                        date: dateStr, time: '08:00', checkPlace: '', ws: 'PRO2', dept: 'PRO2',
                        checked: false, photo: '', notes: ''
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
                if (existingDates[dateStr]) continue;
                if (skipDates[dateStr]) continue;
                db.sysDetail.equipment.push({
                    id: Date.now() + Math.random() + Math.random(),
                    date: dateStr, time: '08:00', checkPlace: '', ws: 'PRO2', dept: 'PE',
                    checked: false, photo: '', notes: ''
                });
                createdCount++;
            }
            if (createdCount > 0) {
                db.sysDetail.equipment.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
                if (window.triggerAutoSave) window.triggerAutoSave();
            }
        }
        window.ensurePostDmPunchData = function(month) {
            if (!db || !db.sysDetail) return;
            if (!db.sysDetail.post) db.sysDetail.post = [];
            var parts = month.split('-');
            if (parts.length < 2) return;
            var year = parseInt(parts[0]);
            var monthNum = parseInt(parts[1]);
            var daysInMonth = new Date(year, monthNum, 0).getDate();
            var skipDates = db.sysDetail._skipDates && db.sysDetail._skipDates.post ? db.sysDetail._skipDates.post : {};
            var existingDmDates = {};
            var _postArr = db.sysDetail.post;
            for (var _pi = 0; _pi < _postArr.length; _pi++) {
                var r = _postArr[_pi];
                if (r && r.type === 'dm_punch' && r.date && String(r.date).startsWith(month)) {
                    existingDmDates[r.date] = true;
                }
            }
            // ★ 性能优化:全部已生成则跳过循环(forEach O(n)已做,进一步用count判断)
            var _totalSkip = 0; for (var _sk in skipDates) if (_sk.startsWith(month)) _totalSkip++;
            if (Object.keys(existingDmDates).length + _totalSkip >= daysInMonth) return;
            var createdCount = 0;
            for (var day = 1; day <= daysInMonth; day++) {
                var dateStr = month + '-' + (day < 10 ? '0' + day : day);
                if (existingDmDates[dateStr]) continue;
                if (skipDates[dateStr]) continue;
                db.sysDetail.post.push({
                    id: Date.now() + Math.random() + Math.random(),
                    date: dateStr, type: 'dm_punch', dmDone: false
                });
                createdCount++;
            }
            if (createdCount > 0) {
                db.sysDetail.post.sort(function(a, b) { return (a.date||'').localeCompare(b.date||''); });
                // ★ 性能优化:延迟保存到渲染之后,避免JSON.stringify阻塞UI
                if (window.triggerAutoSave) {
                    if (typeof _deferredLocalStorageSave === 'function') _deferredLocalStorageSave();
                    setTimeout(function() { window.triggerAutoSave(); }, 100);
                }
            }
        };
        window.onEquipMonthChange = function() {
            ensureEquipmentData();
            renderEquipmentTable();
        };
        window.renderEquipmentTable = function() {
            var monthStr = equipGetMonthStr();
            var wsFilter = document.getElementById('equip-ws-filter') ? document.getElementById('equip-ws-filter').value : '';
            var allData = (db && db.sysDetail && db.sysDetail.equipment) ? db.sysDetail.equipment : [];
            var rows = allData.filter(function(r) { return String(r.date || '').startsWith(monthStr); });
            if (wsFilter) {
                rows = rows.filter(function(r) { return r.ws === wsFilter; });
            }
            var body = document.getElementById('sys-detail-body');
            if (!body) return;
            var total = rows.length;
            var checkedCount = rows.filter(function(r) { return r.checked === true; }).length;
            var checkRate = total > 0 ? (checkedCount / total * 100).toFixed(1) : '0.0';
            var _labelEl = document.getElementById('sys-kpi-1-label'); if (_labelEl) _labelEl.innerText = '总天数';
            _labelEl = document.getElementById('sys-kpi-2-label'); if (_labelEl) _labelEl.innerText = '点检率';
            _labelEl = document.getElementById('sys-kpi-3-label'); if (_labelEl) _labelEl.innerText = '未打卡';
            _labelEl = document.getElementById('sys-kpi-4-label'); if (_labelEl) _labelEl.innerText = '——';
            _labelEl = document.getElementById('sys-detail-impact'); if (_labelEl) { _labelEl.innerText = '—'; _labelEl.style.color = ''; }
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
            body.innerHTML = rows.length ? rows.map(function(r, idx) {
                var gIdx = allData.indexOf(r);
                if (gIdx < 0) gIdx = idx;
                var photoHtml = '';
                if (r.photo && String(r.photo).length > 100) {
                    photoHtml = '<div style="position:relative;display:inline-block;"><img src="' + r.photo + '" style="width:32px;height:32px;object-fit:cover;border-radius:4px;cursor:pointer;border:1px solid #eee;" onclick="window.openPhotoPreview(\'' + r.photo + '\')" ondblclick="equipOpenPhotoModal(' + gIdx + ')" title="单击预览 / 双击更换">' +
                        '<span style="position:absolute;bottom:-2px;right:-4px;font-size:7px;background:#0284c7;color:white;border-radius:8px;padding:0 3px;cursor:pointer;line-height:14px;" onclick="event.stopPropagation();equipOpenPhotoModal(' + gIdx + ')">换</span></div>';
                } else {
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
        window.equipUpdateField = function(index, field, value) {
            try {
                var arr = db && db.sysDetail && db.sysDetail.equipment;
                if (arr && arr[index]) {
                    arr[index][field] = value;
                    if (window.triggerAutoSave) window.triggerAutoSave();
                }
            } catch(e) { console.error('[equipUpdate ERROR]', e.message); }
        };
        window.equipToggleCheck = function(index, checked) {
            try {
                var arr = db && db.sysDetail && db.sysDetail.equipment;
                if (arr && arr[index]) {
                    arr[index].checked = checked;
                    if (window.triggerAutoSave) window.triggerAutoSave();
                    renderEquipmentTable();
                    if (typeof renderSysOps === 'function') renderSysOps();
                }
            } catch(e) { console.error('[equipToggle ERROR]', e.message); }
        };
        window.equipDeleteRow = function(index) {
            if (!db || !db.sysDetail || !db.sysDetail.equipment || !db.sysDetail.equipment[index]) return;
            var r = db.sysDetail.equipment[index];
            if (!confirm('确认删除 ' + (r.date||'') + ' 的设备点检记录？')) return;
            var delDate = r.date;
            db.sysDetail.equipment.splice(index, 1);
            if (!db.sysDetail._skipDates) db.sysDetail._skipDates = {};
            if (!db.sysDetail._skipDates.equipment) db.sysDetail._skipDates.equipment = {};
            db.sysDetail._skipDates.equipment[delDate] = true;
            _deferredLocalStorageSave();
            setTimeout(function() { if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else if (window.triggerAutoSave) { window.triggerAutoSave(); } }, 0);
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
        window.exportEquipmentReport = function() {
            var monthStr = equipGetMonthStr();
            var rows = (db && db.sysDetail && db.sysDetail.equipment) ? db.sysDetail.equipment.filter(function(r) { return String(r.date || '').startsWith(monthStr); }) : [];
            var total = rows.length;
            var checked = rows.filter(function(r) { return r.checked === true; }).length;
            var csv = '设备点检统计表\n\n';
            csv += '项目,数量\n总天数,' + total + '\n已打卡,' + checked + '\n未打卡,' + (total - checked) + '\n点检率,' + (total > 0 ? (checked/total*100).toFixed(1) : '0.0') + '%';
            var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = '设备点检_' + monthStr + '.csv';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
            if (window.showToast) window.showToast('fa-solid fa-file-export', '报表已导出');
        };
        window.currentEquipmentPhotoIndex = null;
        window._equipModalDataUrl = null;
        window._equipModalCompressed = null;
        window.equipOpenPhotoModal = function(index) {
            currentEquipmentPhotoIndex = index;
            _equipModalDataUrl = null;
            _equipModalCompressed = null;
            var row = db && db.sysDetail && db.sysDetail.equipment && db.sysDetail.equipment[index];
            if (row && row.photo) {
                _equipModalDataUrl = row.photo;
                equipModalUpdatePreview();
            }
            document.getElementById('equip-photo-modal').style.display = 'flex';
            if (window._equipModalPasteHandler) {
                document.removeEventListener('paste', window._equipModalPasteHandler);
                delete window._equipModalPasteHandler;
            }
            setTimeout(function() {
                var _ta = document.getElementById('equip-photo-paste-textarea');
                if (_ta) { _ta.focus(); _ta.select(); }
            }, 50);
            window._equipModalPasteHandler = function(e) {
                var modal = document.getElementById('equip-photo-modal');
                if (!modal || modal.style.display !== 'flex') return;
                if (e.defaultPrevented) return;
                equipModalHandlePaste(e);
            };
            document.addEventListener('paste', window._equipModalPasteHandler);
        };
        window.equipClosePhotoModal = function() {
            document.getElementById('equip-photo-modal').style.display = 'none';
            if (window._equipModalPasteHandler) {
                document.removeEventListener('paste', window._equipModalPasteHandler);
                delete window._equipModalPasteHandler;
            }
            _equipModalDataUrl = null;
            _equipModalCompressed = null;
            currentEquipmentPhotoIndex = null;
        };
        window.equipModalHandlePaste = function(event) {
            event.preventDefault();
            event.stopPropagation();
            var clipboardData = event.clipboardData || (event.originalEvent && event.originalEvent.clipboardData);
            if (!clipboardData) return;
            for (var i = 0; i < clipboardData.items.length; i++) {
                var item = clipboardData.items[i];
                if (item.type.startsWith('image/')) {
                    try {
                        var file = item.getAsFile();
                        if (file) { equipModalLoadFile(file); }
                    } catch(e) {
                        console.error('[设备粘贴] 错误:', e);
                        if (window.showToast) showToast('fa-solid fa-xmark', '粘贴图片失败: ' + e.message, 'error');
                    }
                    return;
                }
            }
            if (window.showToast) showToast('fa-solid fa-info-circle', '剪贴板中没有检测到图片');
        };
        window.equipModalHandleFileSelect = function(event) {
            var files = event.target.files;
            if (files && files.length > 0) { equipModalLoadFile(files[0]); }
            event.target.value = '';
        };
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
        window.equipModalUpdatePreview = function() {
            if (!_equipModalDataUrl) {
                document.getElementById('equip-photo-preview').style.display = 'none';
                return;
            }
            document.getElementById('equip-photo-preview').style.display = 'block';
            var previewImg = document.getElementById('equip-photo-preview-img');
            previewImg.src = _equipModalDataUrl;
            var origSize = Math.round(_equipModalDataUrl.length * 0.75 / 1024);
            document.getElementById('equip-photo-orig-size').innerText = origSize + 'KB';
            var qSlider = document.getElementById('equip-photo-quality');
            var qLabel = document.getElementById('equip-photo-quality-label');
            if (qSlider && qLabel) {
                qLabel.innerText = Math.round(parseFloat(qSlider.value) * 100) + '%';
            }
            equipModalCompressCurrent();
        };
        window.equipModalCompressCurrent = function() {
            if (!_equipModalDataUrl) return;
            var qSlider = document.getElementById('equip-photo-quality');
            var quality = qSlider ? parseFloat(qSlider.value) : 0.35;
            equipCompressImageToDataUrl(_equipModalDataUrl, 150, quality).then(function(compressed) {
                _equipModalCompressed = compressed;
                var compSize = Math.round(compressed.length * 0.75 / 1024);
                document.getElementById('equip-photo-comp-size').innerText = compSize + 'KB';
                document.getElementById('equip-photo-preview-img').src = compressed;
            });
        };
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
                if (window.showToast) showToast('fa-solid fa-exclamation-triangle', '数据不存在', 'error');
                return;
            }
            db.sysDetail.equipment[currentEquipmentPhotoIndex].photo = toSave;
            if (window.triggerAutoSave) window.triggerAutoSave();
            if (typeof renderEquipmentTable === 'function') renderEquipmentTable();
            if (typeof renderSysOps === 'function') renderSysOps();
            equipClosePhotoModal();
            if (window.showToast) showToast('fa-solid fa-check-circle', '图片已添加');
        };
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
                img.onerror = function() { resolve(dataUrl); };
                img.src = dataUrl;
            });
        };
        window.equipHandlePaste = function(event, index) {
            event.preventDefault();
            event.stopPropagation();
            equipOpenPhotoModal(index);
        };
        window.equipHandleDrop = function(event, index) {
            event.preventDefault();
            equipOpenPhotoModal(index);
        };
        let currentSysDetailType = 'equipment';
        const SYS_DETAIL_META = {
            mid: { title: '事中:Andon响应记录明细', icon: 'fa-gauge-high' },
            post: { title: '事后:闭环与复发复盘', icon: 'fa-flag-checkered' },
            equipment: { title: '每日设备点检记录', icon: 'fa-screwdriver-wrench' }
        };
        window.openSysDetail = function(type) {
            currentSysDetailType = type;
            repairData(); // 确保数据结构完整
            ensureSysData(window.safeDOM.val("globalDate"));
            // ★ 修复：切换模块时正确显示/隐藏toolbar与equip-filter-bar，互不污染
            var _toolbar = document.querySelector('.sys-detail-toolbar');
            var _equipFilter = document.getElementById('equip-filter-bar');
            if (type === 'equipment') {
                if (_toolbar) _toolbar.style.display = 'none';
                if (_equipFilter) _equipFilter.style.display = 'flex';
            } else {
                if (_toolbar) _toolbar.style.display = 'flex';
                if (_equipFilter) _equipFilter.style.display = 'none';
            }
            var _monthEl = document.getElementById('sys-detail-month');
            if (_monthEl) _monthEl.value = window.safeDOM.val("globalDate").substring(0, 7);
            // 兼容旧pre→重定向到equipment
            if (type === 'pre') type = 'equipment';
            document.getElementById('sys-detail-title').innerHTML = `<i class="fa-solid ${SYS_DETAIL_META[type].icon}"></i> ${SYS_DETAIL_META[type].title}`;
            document.getElementById('btn-sys-ai-repeat').style.display = type === 'post' ? 'flex' : 'none';
            // 切换非事后模块时隐藏AI分析结果
            var _aiWrap = document.getElementById('sys-ai-repeat-wrapper');
            if (_aiWrap) _aiWrap.style.display = 'none';
            document.getElementById('sys-detail-panel').style.display = 'flex';
            typeof renderSysDetail==="function"&&renderSysDetail();
        };
        window.closeSysDetail = function() {
            // 关闭前确保数据完整并立即保存
            repairData();
            triggerAutoSave();
            // Firebase 云端同步已集成到 triggerAutoSave
            document.getElementById('sys-detail-panel').style.display = 'none'; 
            // ★ 确保图片粘贴模态框也关闭
            var _photoModal = document.getElementById('equip-photo-modal');
            if (_photoModal && _photoModal.style.display === 'flex') {
                _photoModal.style.display = 'none';
                if (window._equipModalPasteHandler) {
                    document.removeEventListener('paste', window._equipModalPasteHandler);
                    delete window._equipModalPasteHandler;
                }
                window._equipModalDataUrl = null;
                window._equipModalCompressed = null;
                window.currentEquipmentPhotoIndex = null;
            }
        };
        function sysDetailRows() {
            ensureSysData(window.safeDOM.val("globalDate"));
            return db.sysDetail[currentSysDetailType] || [];
        }
        window.addSysRecord = function() {
            if (currentSysDetailType === 'post') {
                // 新增改善项目（不含预设）
                db.sysDetail.post.unshift({
                    id: Date.now()+Math.random(),
                    date: window.safeDOM.val("globalDate"),
                    type: 'improvement',
                    projectName: '',
                    target: '',
                    progress: '',
                    notes: ''
                });
                triggerAutoSave(); typeof renderSysDetail==="function"&&renderSysDetail(); renderSysOps();
                return;
            }
            if (currentSysDetailType === 'equipment') {
                // 手动添加单条设备点检记录
                const today = window.safeDOM.val("globalDate");
                db.sysDetail.equipment.unshift({
                    id: Date.now()+Math.random(),
                    date: today,
                    time: '08:00',
                    checkPlace: '',
                    ws: 'PRO2',
                    dept: 'PRO2',
                    checked: false,
                    photo: '',
                    notes: ''
                });
                triggerAutoSave(); typeof renderSysDetail==="function"&&renderSysDetail(); renderSysOps();
                return;
            }
            const today = window.safeDOM.val("globalDate");
            const base = currentSysDetailType === 'pre'
                ? { id: Date.now()+Math.random(), date: today, ws:'PRO2', ownerDept:'PRO2', line:'LINE A', item:'关键设备点检', equipment:'焊接/测试关键设备', issue:'', resp:'', status:'已完成' }
                : { id: Date.now()+Math.random(), date: today, ws:'PRO2', line:'LINE A', event:'Andon异常响应', responseMin:5, waitMin:0, impactQty:0, patrol:'现场巡检OK', action:'', resp:'', status:'已关闭' };
            db.sysDetail[currentSysDetailType].unshift(base);
            triggerAutoSave(); typeof renderSysDetail==="function"&&renderSysDetail(); renderSysOps();
        };
        window.updateSysRecord = function(id, field, value) {
            const row = sysDetailRows().find(r => String(r.id) === String(id));
            if (!row) return console.warn('Record not found:', id);
            row[field] = ['plan','actual','responseMin','waitMin','impactQty'].includes(field) ? safeNum(value) : value;
            // ★ 事中模块自动计算停机时长：每小时产量420台 = 每分钟7台
            if (currentSysDetailType === 'mid' && field === 'impactQty') {
                row.waitMin = Math.round(safeNum(value) / 7);
            }
            // ★ 事中模块：手动改了waitMin也同步更新显示
            // 立即保存并同步
            triggerAutoSave();
            typeof renderSysDetail==="function"&&renderSysDetail(); renderSysOps();
        };
        window.delSysRecord = function(id) {
            // 找到要删除的记录，取出日期
            var delRow = sysDetailRows().find(function(r) { return String(r.id) === String(id); });
            if (delRow) {
                // ★ 修复Bug6:所有模块的预设类型都记录删除日期，防止 ensureSysDetailPresetData 重新生成
                if (!db.sysDetail._skipDates) db.sysDetail._skipDates = {};
                if (!db.sysDetail._skipDates[currentSysDetailType]) db.sysDetail._skipDates[currentSysDetailType] = {};
                db.sysDetail._skipDates[currentSysDetailType][delRow.date] = true;
            }
            db.sysDetail[currentSysDetailType] = sysDetailRows().filter(r => String(r.id) !== String(id));
            // ★ 性能优化:延迟保存 localStorage,不阻塞 UI 渲染
            _deferredLocalStorageSave();
            // ★ 性能优化:延迟 forceSaveToFirebase 到下一 macrotask,避免 repairData+sanitize 阻塞 UI
            setTimeout(function() {
                if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else { triggerAutoSave(); }
            }, 0);
            typeof renderSysDetail==="function"&&renderSysDetail(); renderSysOps();
        };
        // ★ 性能优化:LOSS重复率统计结果缓存(3秒内同月不重复计算bigram相似度)
        var _lossRepeatCache = {};
        var _lossRepeatCacheTime = {};
        function _getCachedLossStats(lossArr, monthKey, threshold) {
            var key = monthKey + '|' + (threshold || 0.75);
            var now = Date.now();
            if (_lossRepeatCache[key] !== undefined && _lossRepeatCacheTime[key] && (now - _lossRepeatCacheTime[key] < 3000)) {
                return _lossRepeatCache[key];
            }
            return null;
        }
        function _setCachedLossStats(lossArr, monthKey, threshold, result) {
            var key = monthKey + '|' + (threshold || 0.75);
            _lossRepeatCache[key] = result;
            _lossRepeatCacheTime[key] = Date.now();
            // 限制缓存条目防止内存泄漏
            var keys = Object.keys(_lossRepeatCache);
            while (keys.length > 5) {
                var oldest = keys[0];
                delete _lossRepeatCache[oldest];
                delete _lossRepeatCacheTime[oldest];
                keys = Object.keys(_lossRepeatCache);
            }
        }
        // ★ 主范围默认日期:当月第一天
        function _defaultMainStart() {
            var d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-01';
        }
        // ★ 主范围默认日期:当天
        function _defaultMainEnd() {
            var d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        }
        // ★ 主范围日期变更处理
        window._handleMainRangeChange = function() {
            console.log('[DEBUG] _handleMainRangeChange 触发');
            typeof renderSysDetail==='function'&&renderSysDetail();
        };
        window.renderSysDetail = function() {
        try {
            // ★ 性能诊断标记
            if (currentSysDetailType === 'post' && window._renderStart === undefined) window._renderStart = performance.now();
            if (currentSysDetailType === 'post' && !window._perfMarks) window._perfMarks = {};
            if (currentSysDetailType === 'post') window._perfMarks.start = performance.now();
            const _mEl = document.getElementById('sys-detail-month');
            const month = _mEl ? _mEl.value : window.safeDOM.val("globalDate").substring(0, 7);
            const ownerFilter = document.getElementById('sys-detail-owner-filter') ? document.getElementById('sys-detail-owner-filter').value : '';
            const head = document.getElementById('sys-detail-head');
            const body = document.getElementById('sys-detail-body');
            // ★ 修复Bug1:每次渲染前重置KPI标签，避免设备点检模块占用错误标签
            (function(){
                var _lbls = ['sys-kpi-1-label','sys-kpi-2-label','sys-kpi-3-label','sys-kpi-4-label'];
                _lbls.forEach(function(id){
                    var el = document.getElementById(id);
                    if(el) el.innerText = '——';
                });
                ['sys-detail-count','sys-detail-rate','sys-detail-risk','sys-detail-impact'].forEach(function(id){
                    var el = document.getElementById(id);
                    if(el) { el.innerText = '0'; el.style.color = ''; }
                });
            })();
            // Auto-generate daily preset data for pre/mid/equipment modules
            if (['pre', 'mid', 'equipment'].includes(currentSysDetailType)) {
                ensureSysDetailPresetData(month, currentSysDetailType);
                // ★ 恢复主表格显示（如果之前事后模块隐藏了它）
                var _tbl = document.querySelector('.sys-detail-table');
                if (_tbl) _tbl.style.display = '';
                // ★ 隐藏事后自定义布局
                var _pLayout = document.getElementById('sys-detail-post-layout');
                if (_pLayout) _pLayout.style.display = 'none';
            }
            const addBtn = document.querySelector('#sys-detail-panel .btn-primary');
            if (addBtn) addBtn.style.display = 'flex'; // 事后模块也需要显示（新增改善项目）
            if (currentSysDetailType === 'post') {
                // ★ 事后模块加载提示:首次渲染时显示加载中,避免用户以为卡死
                if (window._postLoading === undefined) {
                    window._postLoading = true;
                    var _pl = document.getElementById('sys-detail-post-layout');
                    var _postTable2 = document.querySelector('.sys-detail-table');
                    if (_postTable2) _postTable2.style.display = 'none';
                    if (_pl) {
                        _pl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:50px 20px;gap:12px;"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px;color:var(--primary);"></i><span style="font-size:14px;color:var(--text-muted);font-weight:600;">加载中，请稍候...</span></div>';
                    } else {
                        var _pw = document.querySelector('.table-wrap');
                        if (_pw) {
                            _pl = document.createElement('div');
                            _pl.id = 'sys-detail-post-layout';
                            _pl.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
                            _pl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:50px 20px;gap:12px;"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px;color:var(--primary);"></i><span style="font-size:14px;color:var(--text-muted);font-weight:600;">加载中，请稍候...</span></div>';
                            _pw.appendChild(_pl);
                        }
                    }
                    setTimeout(function() { renderSysDetail(); }, 50);
                    return;
                }
                // 事后模块：DM每日打卡
                if (window._perfMarks) window._perfMarks.afterKPI = performance.now();
                
                // ── 自动生成 DM 每日打卡数据 ──
                window.ensurePostDmPunchData && window.ensurePostDmPunchData(month);
                
                // ── KPI指标 ──
                var postRows = sysDetailRows().filter(function(r) { return String(r.date||'').startsWith(month); });
                var dmRows = postRows.filter(function(r) { return r.type === 'dm_punch'; });
                var improveRows = postRows.filter(function(r) { return r.type === 'improvement'; });
                var dmChecked = dmRows.filter(function(r) { return r.dmDone === true; }).length;
                var dmDoneRate = dmRows.length > 0 ? Math.round(dmChecked / dmRows.length * 100) : 0;
                // ★ 主范围：从日期范围输入框获取起始+结束日期
                var _msEl = document.getElementById('sys-main-start');
                var _meEl = document.getElementById('sys-main-end');
                var _mainStart = (_msEl && _msEl.value) || localStorage.getItem('mbs_main_start') || _defaultMainStart();
                var _mainEnd = (_meEl && _meEl.value) || localStorage.getItem('mbs_main_end') || _defaultMainEnd();
                // 确保日期格式有效(至少10字符 YYYY-MM-DD)
                if (!_mainStart || String(_mainStart).length < 10) _mainStart = _defaultMainStart();
                if (!_mainEnd || String(_mainEnd).length < 10) _mainEnd = _defaultMainEnd();
                // ★ 初始化主范围输入框（空值时填入默认值）
                if (_msEl && !_msEl.value) { _msEl.value = _mainStart; }
                if (_meEl && !_meEl.value) { _meEl.value = _mainEnd; }
                var _mainRangeLabel = String(_mainStart).substring(5) + ' 至 ' + String(_mainEnd).substring(5);
                var _lossesMain = (db.loss || []).filter(function(l) {
                    return l.date && String(l.date) >= String(_mainStart) && String(l.date) <= String(_mainEnd);
                });
                console.log('[DEBUG] 主范围: start=', _mainStart, 'end=', _mainEnd, 'lossesCount=', _lossesMain.length);
                function _safeStr(s) { return String(s||'').trim().toLowerCase(); }
                function _charBigramSimilarity(a, b) {
                    a = _safeStr(a); b = _safeStr(b);
                    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
                    // 将前缀相同部分对齐后计算bigram重叠率
                    var bgA = {}; for(var i=0;i<a.length-1;i++) { var bg=a.substring(i,i+2); bgA[bg]=(bgA[bg]||0)+1; }
                    var inter=0; for(var i=0;i<b.length-1;i++) { var bg=b.substring(i,i+2); if(bgA[bg]>0){bgA[bg]--; inter++;} }
                    var union = Math.max(a.length, b.length) - 1;
                    return union > 0 ? inter / union : 0;
                }
                function _calcRepeatStatsSim(lossArr, threshold) {
                    threshold = threshold || 0.75;
                    var clusters = []; // 每个cluster: { key, items: [] }
                    lossArr.forEach(function(l) {
                        if(!l || !l.desc) return;
                        var desc = String(l.desc).trim();
                        var matched = false;
                        for(var ci = 0; ci < clusters.length; ci++) {
                            var clusterKey = clusters[ci].key;
                            if(_charBigramSimilarity(desc, clusterKey) >= threshold) {
                                clusters[ci].items.push(l);
                                matched = true;
                                break;
                            }
                        }
                        if(!matched) {
                            clusters.push({ key: desc, items: [l] });
                        }
                    });
                    var events = 0, buckets = 0;
                    clusters.forEach(function(c) { if(c.items.length > 1) { buckets++; events += c.items.length; } });
                    var map = {};
                    clusters.forEach(function(c) { map[c.key] = c.items.length; });
                    return { total: lossArr.length, events: events, buckets: buckets, map: map,
                        rate: lossArr.length > 0 ? Math.round(events / lossArr.length * 100) : 0 };
                }
                var SIM_THRESHOLD = 0.75; // 75%相似度阈值为重复事件
                var curStats = _getCachedLossStats(_lossesMain, _mainStart + '_' + _mainEnd, SIM_THRESHOLD);
                if (!curStats) {
                    curStats = _calcRepeatStatsSim(_lossesMain, SIM_THRESHOLD);
                    _setCachedLossStats(_lossesMain, _mainStart + '_' + _mainEnd, SIM_THRESHOLD, curStats);
                }

                
                // 重复TOP5（基于相似度聚类后的统计）
                var sortedDesc = Object.keys(curStats.map).sort(function(a,b) { return curStats.map[b] - curStats.map[a]; });
                var top5Html = sortedDesc.slice(0,5).map(function(k) {
                    return '<span style="font-size:11px;color:var(--text-main);border-bottom:1px dashed var(--border-light);padding:2px 0;display:flex;justify-content:space-between;">' +
                        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;font-weight:600;">' + escapeHtml(k) + '</span>' +
                        '<span style="font-weight:900;color:' + (curStats.map[k] >= 3 ? 'var(--danger)' : 'var(--warning)') + ';margin-left:8px;">×' + curStats.map[k] + '次</span>' +
                    '</span>';
                }).join('') || '<span style="font-size:11px;color:var(--text-muted);">暂无重复LOSS</span>';
                function escapeHtml(str) {
                    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
                }
                
                document.getElementById('sys-kpi-1-label').innerText = 'DM记录';
                document.getElementById('sys-detail-count').innerText = dmRows.length;
                document.getElementById('sys-kpi-2-label').innerText = '开展率';
                document.getElementById('sys-detail-rate').innerText = dmDoneRate + '%';
                document.getElementById('sys-kpi-3-label').innerText = '打卡天数';
                document.getElementById('sys-detail-risk').innerText = dmChecked;
                document.getElementById('sys-kpi-4-label').innerText = '——';
                document.getElementById('sys-detail-impact').innerText = '—';
                
                // ── 隐藏原表格，使用自定义分割布局 ──
                var _postTable = document.querySelector('.sys-detail-table');
                if (!_postTable) _postTable = document.querySelector('.sys-detail-table');
                if (_postTable) _postTable.style.display = 'none';
                
                var _postWrap = document.querySelector('.table-wrap');
                if (!_postWrap) _postWrap = document.querySelector('.table-wrap');
                if (!_postWrap) { head.innerHTML = ''; body.innerHTML = '<tr><td>布局容器不存在</td></tr>'; return; }
                
                // 创建或重用事后布局容器
                var _postLayout = document.getElementById('sys-detail-post-layout');
                if (!_postLayout) {
                    _postLayout = document.createElement('div');
                    _postLayout.id = 'sys-detail-post-layout';
                    _postWrap.appendChild(_postLayout);
                }
                _postLayout.style.display = 'flex';
                _postLayout.style.flexDirection = 'column';
                _postLayout.style.gap = '10px';
                
                // DM打卡表格行
                var dmTableHtml = dmRows.map(function(r) {
                    return '<tr>' +
                        '<td style="padding:5px 8px;font-size:12px;white-space:nowrap;">' + r.date + '</td>' +
                        '<td style="text-align:center;padding:5px 8px;"><input type="checkbox" ' + (r.dmDone ? 'checked' : '') + ' onchange="updateSysRecord(\'' + r.id + '\',\'dmDone\',this.checked)" style="width:18px;height:18px;cursor:pointer;accent-color:var(--primary);"></td>' +
                        '<td style="text-align:center;padding:5px 8px;"><i class="fa-solid fa-xmark" style="color:var(--danger);cursor:pointer;font-size:14px;" onclick="delSysRecord(\'' + r.id + '\')" title="删除该行"></i></td>' +
                    '</tr>';
                }).join('');
                
                // 改善项目表格行
                var improveTableHtml = improveRows.map(function(r) {
                    return '<tr>' +
                        '<td style="padding:5px 8px;"><input type="date" value="' + r.date + '" onchange="updateSysRecord(\'' + r.id + '\',\'date\',this.value)" style="width:110px;font-size:12px;border:none;text-align:center;font-weight:600;background:transparent;"></td>' +
                        '<td style="padding:5px 8px;"><input value="' + (r.projectName||'') + '" onchange="updateSysRecord(\'' + r.id + '\',\'projectName\',this.value)" placeholder="改善项目名称" style="width:100%;border:none;font-size:12px;font-weight:600;background:transparent;"></td>' +
                        '<td style="padding:5px 8px;"><input value="' + (r.target||'') + '" onchange="updateSysRecord(\'' + r.id + '\',\'target\',this.value)" placeholder="目标" style="width:100%;border:none;font-size:12px;font-weight:600;background:transparent;"></td>' +
                        '<td style="padding:5px 8px;"><input value="' + (r.progress||'') + '" onchange="updateSysRecord(\'' + r.id + '\',\'progress\',this.value)" placeholder="进展" style="width:100%;border:none;font-size:12px;font-weight:600;background:transparent;"></td>' +
                        '<td style="text-align:center;padding:5px 8px;"><i class="fa-solid fa-xmark" style="color:var(--danger);cursor:pointer;font-size:14px;" onclick="delSysRecord(\'' + r.id + '\')" title="删除该行"></i></td>' +
                    '</tr>';
                }).join('');
                
                _postLayout.innerHTML = '' +
                    // ── 仅保留 DM 每日打卡（全宽） ──
                    '<div style="flex:1;overflow-y:auto;background:var(--bg-panel);border-radius:var(--radius);border:1px solid var(--border);">' +
                        '<div style="position:sticky;top:0;z-index:2;font-weight:900;font-size:13px;padding:6px 10px;background:var(--midea-blue);color:#fff;border-radius:var(--radius) var(--radius) 0 0;display:flex;align-items:center;gap:8px;">' +
                            '<i class="fa-solid fa-clipboard-check"></i> DM每日打卡（全月自动生成）' +
                        '</div>' +
                        '<table class="grid" style="min-width:auto;">' +
                            '<thead><tr>' +
                                '<th style="width:100px;">日期</th>' +
                                '<th style="width:60px;">打卡✓</th>' +
                                '<th style="width:40px;">删</th>' +
                            '</tr></thead>' +
                            '<tbody>' + (dmTableHtml || '<tr><td colspan="3" style="text-align:center;padding:20px;color:#999;">暂无数据</td></tr>') + '</tbody>' +
                        '</table>' +
                    '</div>';
                // ★ 性能诊断:标记渲染结束
                if (window._perfMarks) {
                    window._perfMarks.afterInnerHTML = performance.now();
                    console.log('[性能] 事后渲染耗时:', 
                        '数据准备=', (window._perfMarks.afterKPI - window._perfMarks.start).toFixed(1), 'ms',
                        'innerHTML=', (window._perfMarks.afterInnerHTML - window._perfMarks.afterKPI).toFixed(1), 'ms',
                        '总=', (window._perfMarks.afterInnerHTML - window._perfMarks.start).toFixed(1), 'ms'
                    );
                    delete window._perfMarks; // 清除标记,下次重新测量
                }
                window._postLoading = true;
                return;
            }

            if (currentSysDetailType === 'equipment') {
                // 设备点检：使用独立过滤器栏，不破坏主toolbar（修复：避免toolbar元素丢失导致其他模块渲染崩溃）
                var _tb2 = document.querySelector('.sys-detail-toolbar');
                var equipFilter = document.getElementById('equip-filter-bar');
                if (!equipFilter) {
                    equipFilter = document.createElement('div');
                    equipFilter.id = 'equip-filter-bar';
                    equipFilter.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;font-size:12px;';
                    if (_tb2 && _tb2.parentNode) {
                        _tb2.parentNode.insertBefore(equipFilter, _tb2.nextSibling);
                    }
                }
                if (_tb2) _tb2.style.display = 'none';
                equipFilter.style.display = 'flex';
                equipFilter.innerHTML = `
                    <span style="font-weight:900;">月份</span>
                    <select id="equip-month-select" class="btn" onchange="onEquipMonthChange()" style="font-size:12px;padding:4px 8px;">
                        <option value="1" >1月</option><option value="2" >2月</option><option value="3" >3月</option><option value="4" >4月</option><option value="5" selected>5月</option><option value="6" >6月</option><option value="7" >7月</option><option value="8" >8月</option><option value="9" >9月</option><option value="10" >10月</option><option value="11" >11月</option><option value="12" >12月</option>
                    </select>
                    <span style="font-weight:900;">车间</span>
                    <select id="equip-ws-filter" class="btn" onchange="renderEquipmentTable()" style="font-size:12px;padding:4px 8px;">
                        <option value="">全部</option>
                        <option value="PRO1">PRO1</option>
                        <option value="PRO2">PRO2</option>
                        <option value="PRO3">PRO3</option>
                        <option value="PRO4">PRO4</option>
                    </select>
                    <span style="color:var(--text-muted);font-weight:800;">选月份后自动生成每日打卡行</span>
                `;
                
                // 使用标准 sys-kpi-strip（不另加自定义KPI卡片）
                // 更新 KPI 由 renderEquipmentTable 负责

                head.innerHTML = `
                    <tr>
                        <th style="width:12%;">日期</th>
                        <th style="width:24%;">点检位置</th>
                        <th style="width:12%;">车间</th>
                        <th style="width:18%;">责任部门</th>
                        <th style="width:10%;">打卡⬜</th>
                        <th style="width:18%;">图片(Ctrl+V)</th>
                        <th style="width:6%;">删</th>
                    </tr>
                `;

                // 自动初始化当月数据
                ensureEquipmentData();
                renderEquipmentTable();
                return;
            }

            const rows = sysDetailRows().filter(r => String(r.date || '').startsWith(month) && (!ownerFilter || r.ws === ownerFilter || r.ownerDept === ownerFilter));
            document.getElementById('sys-detail-count').innerText = rows.length;
            if (currentSysDetailType === 'pre') {
                var showUnconfirmed = document.getElementById('sys-show-unconfirmed') && document.getElementById('sys-show-unconfirmed').checked;
                var filteredRows = rows;
                if(showUnconfirmed) filteredRows = rows.filter(function(r){ return r.status !== '已完成'; });
                const ok = filteredRows.filter(r => safeNum(r.actual) >= safeNum(r.plan)).length;
                document.getElementById('sys-kpi-1-label').innerText = '记录数量';
                document.getElementById('sys-kpi-2-label').innerText = '达成率';
                document.getElementById('sys-detail-rate').innerText = (rows.length ? (ok / rows.length * 100).toFixed(1) : 100) + '%';
                document.getElementById('sys-kpi-3-label').innerText = '待跟进';
                document.getElementById('sys-detail-risk').innerText = rows.filter(r => r.status !== '已完成').length;
                document.getElementById('sys-kpi-4-label').innerText = '——';
                document.getElementById('sys-detail-impact').innerText = '—';
                head.innerHTML = `<tr><th>日期</th><th>车间</th><th>责任归属</th><th style="min-width:160px;">线体/设备</th><th style="min-width:160px;">检查项目</th><th>异常说明</th><th>责任人</th><th>状态</th><th>删</th></tr>`;
                body.innerHTML = filteredRows.map(function(r){
                    var rowBg = r.status !== '已完成' ? ' style="background:rgba(239,68,68,0.06);"' : '';
                    return `<tr${rowBg}>
                    <td><input type="date" value="${r.date}" onchange="updateSysRecord('${r.id}','date',this.value)"></td>
                    <td><select onchange="updateSysRecord('${r.id}','ws',this.value)">${PRO_ORDER.map(ws=>`<option ${r.ws===ws?'selected':''}>${ws}</option>`).join('')}</select></td>
                    <td><select onchange="updateSysRecord('${r.id}','ownerDept',this.value)">${['PRO1','PRO2','PRO3','PRO4','PE'].map(d=>`<option ${r.ownerDept===d?'selected':''}>${d}</option>`).join('')}</select></td>
                    <td><input value="${r.equipment||r.line||''}" onchange="updateSysRecord('${r.id}','equipment',this.value)" style="width:100%;min-width:140px;"></td>
                    <td><input value="${r.item||''}" onchange="updateSysRecord('${r.id}','item',this.value)" style="width:100%;min-width:140px;"></td>
                    <td><input value="${r.issue||''}" onchange="updateSysRecord('${r.id}','issue',this.value)" style="width:100%;"></td>
                    <td><input value="${r.resp||''}" onchange="updateSysRecord('${r.id}','resp',this.value)"></td>
                    <td><select onchange="updateSysRecord('${r.id}','status',this.value)"><option ${r.status==='已完成'?'selected':''}>已完成</option><option ${r.status==='处理中'?'selected':''}>处理中</option><option ${r.status==='未完成'?'selected':''}>未完成</option></select></td>
                    <td><button onclick="delSysRecord('${r.id}')" style="border:none;background:none;color:var(--danger);cursor:pointer;"><i class="fa-solid fa-trash-can"></i></button></td>
                </tr>`;
                }).join('') || `<tr><td colspan="9">暂无事前记录,点击新增记录开始录入</td></tr>`;
            } else {
                const avgResp = rows.length ? (rows.reduce((s,r)=>s+safeNum(r.responseMin),0)/rows.length).toFixed(1) : '-';
                const totalWait = rows.reduce((s,r)=>s+safeNum(r.waitMin),0);
                const avgWait = rows.length ? (rows.reduce((s,r)=>s+safeNum(r.waitMin),0)/rows.length).toFixed(1) : '-';
                const totalImpact = rows.reduce((s,r)=>s+safeNum(r.impactQty),0);
                document.getElementById('sys-kpi-1-label').innerText = '本月记录';
                document.getElementById('sys-detail-count').innerText = rows.length;
                document.getElementById('sys-kpi-2-label').innerText = '平均响应';
                document.getElementById('sys-detail-rate').innerText = (avgResp==='-'?'-':avgResp) + '分';
                document.getElementById('sys-kpi-3-label').innerText = '停机时长';
                document.getElementById('sys-detail-risk').innerHTML = totalWait + '分 <span style="font-size:10px;color:var(--text-muted);font-weight:600;">(均' + (avgWait==='-'?'-':avgWait) + '分)</span>';
                document.getElementById('sys-kpi-4-label').innerText = '影响数量';
                document.getElementById('sys-detail-impact').innerText = totalImpact + '件';
                head.innerHTML = `<tr><th style="width:10%;">日期</th><th style="width:8%;">车间</th><th style="width:8%;">线体</th><th style="width:34%;">事件</th><th style="width:10%;">响应(分)</th><th style="width:10%;">停机(分)</th><th style="width:10%;">影响数</th><th style="width:6%;">责任人</th><th style="width:4%;">删</th></tr>`;
                body.innerHTML = rows.map(r => `<tr>
                    <td><input type="date" value="${r.date}" onchange="updateSysRecord('${r.id}','date',this.value)" style="width:100%;"></td>
                    <td><select onchange="updateSysRecord('${r.id}','ws',this.value)" style="width:100%;">${PRO_ORDER.map(ws=>`<option ${r.ws===ws?'selected':''}>${ws}</option>`).join('')}</select></td>
                    <td><input value="${r.line||''}" onchange="updateSysRecord('${r.id}','line',this.value)" style="width:100%;"></td>
                    <td><input value="${r.event||''}" onchange="updateSysRecord('${r.id}','event',this.value)" style="width:100%;min-width:160px;"></td>
                    <td><input type="number" value="${r.responseMin||0}" onchange="updateSysRecord('${r.id}','responseMin',this.value)" style="width:50px;"></td>
                    <td><input type="number" value="${r.waitMin||0}" readonly title="由影响数自动计算(420台/时)" style="width:50px;background:var(--bg-card);color:var(--primary);font-weight:700;"></td>
                    <td><input type="number" value="${r.impactQty||0}" onchange="updateSysRecord('${r.id}','impactQty',this.value)" style="width:55px;"></td>
                    <td><input value="${r.resp||''}" onchange="updateSysRecord('${r.id}','resp',this.value)" style="width:100%;"></td>
                    <td><button onclick="delSysRecord('${r.id}')" style="border:none;background:none;color:var(--danger);cursor:pointer;"><i class="fa-solid fa-trash-can"></i></button></td>
                </tr>`).join('') || `<tr><td colspan="9">暂无事中记录,点击新增记录开始录入</td></tr>`;
            }
        } catch(e) { console.error('[renderSysDetail ERROR]', e.message, 'line', e.lineNumber || (e.stack||'').split('\n')[1]); }
        };
        window.aiAnalyzeSystemRepeat = async function() {
            const _mEl2 = document.getElementById('sys-detail-month');
            const month = _mEl2 ? _mEl2.value : window.safeDOM.val("globalDate").substring(0, 7);
            const wrapper = document.getElementById('sys-ai-repeat-wrapper');
            const target = document.getElementById('sys-ai-repeat-result');
            const badge = document.getElementById('sys-ai-summary-badge');
            
            // 获取本月+上月LOSS数据
            const parts = month.split('-');
            const year = parseInt(parts[0]);
            const m = parseInt(parts[1]);
            const prevMonth = m === 1 ? (year-1)+'-12' : year+'-'+(m<10?'0':'')+(m-1);
            
            const thisMonthLoss = (db.loss || []).filter(l => String(l.date || '').startsWith(month));
            const prevMonthLoss = (db.loss || []).filter(l => String(l.date || '').startsWith(prevMonth));
            
            if(!thisMonthLoss.length) return showToast('fa-solid fa-info-circle', '本月暂无LOSS可分析');
            
            wrapper.style.display = 'block';
            target.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> AI 正在分析重复LOSS数据...</div>';
            
            // 构建结构化提示词 — 纯数据分析，不做建议
            const buildLossSummary = function(arr, label) {
                if (!arr.length) return label + '：无数据';
                // 按周分组
                var weekMap = {};
                arr.forEach(function(l) {
                    var d = l.date || '';
                    var day = parseInt(d.substring(8,10)) || 0;
                    var wk = Math.ceil(day/7);
                    if (!weekMap[wk]) weekMap[wk] = [];
                    weekMap[wk].push(l);
                });
                var lines = [label + '：'];
                Object.keys(weekMap).sort(function(a,b){return a-b}).forEach(function(wk) {
                    var items = weekMap[wk];
                    var descs = items.map(function(l){return '['+l.date+']['+(l.dept||'')+']['+(l.line||'')+']['+(l.shift||'')+'] '+l.desc+' (损失:'+l.qty+')';}).join('\n');
                    lines.push('--- 第'+wk+'周（'+(items.length)+'条记录）---\n'+descs);
                });
                return lines.join('\n');
            };
            
            var promptData = buildLossSummary(thisMonthLoss, '本月LOSS') + '\n\n' + buildLossSummary(prevMonthLoss, '上月LOSS');
            
            const prompt = promptData
                + '\n\n请基于以上真实数据做严格统计分析，输出HTML（不用Markdown，表格加class="ai-result-table"）：\n'
                + '1. **本周重复LOSS统计**（按周）：每周重复条目数（相同或语义相近描述出现2次+），列出每周具体重复问题名称及次数\n'
                + '2. **周环比**：每周重复LOSS数对比上周变化量（+/-）及改善率\n'
                + '3. **月环比**：本月重复LOSS总数对比上月的变化量及改善率\n'
                + '4. **重复LOSS TOP5**：本月重复最多的5个问题及影响套数\n'
                + '5. **责任部门分布**：按部门统计重复LOSS分布\n'
                + '6. **线体分布**：按LINE A/B/C/D统计重复集中度\n\n'
                + '红线：只基于数据做统计，严禁编造数据。每条结论必须有数字引用。仅结尾可加一句话的建议。';
            
            const ans = await callAI_API(prompt);
            target.innerHTML = ans || 'AI 分析失败，请稍后重试。';
            if (badge) badge.innerText = thisMonthLoss.length + '条LOSS已分析';
        };
        window.toggleAIReplyRepeat = function() {
            var result = document.getElementById('sys-ai-repeat-result');
            var icon = document.getElementById('sys-ai-toggle-icon');
            if (!result || !icon) return;
            if (result.style.display === 'none') {
                result.style.display = 'block';
                icon.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
            } else {
                result.style.display = 'none';
                icon.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
            }
        };
        // ================= 报告 AI 生成分析 =================
        window.aiAnalyzePSP = async function(btn) {
            let start = document.getElementById('psp-ai-start').value; let end = document.getElementById('psp-ai-end').value;
            if(!start || !end) return;
            let oldHtml = btn.innerHTML; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 诊断中...`; btn.disabled = true;
            let probs = db.problems.filter(p => p.date >= start && p.date <= end).map(p => `[${p.date}] [${p.dept}] ${p.ws} ${p.loc}: ${p.desc} (${p.status})`);
            if(probs.length === 0) { btn.innerHTML = oldHtml; btn.disabled = false; return showToast('fa-solid fa-info-circle', `暂无异常记录`); }
                        // ★ V2优化：数据驱动90% + GMCC背景 + 趋势分析
            var pspTotal = probs.length;
            var pspClosed = probs.filter(function(p){ return p.status === '已解决' || p.status === 'Closed' || p.status === 'แก้ไขแล้ว'; }).length;
            var pspCloseRate = pspTotal > 0 ? Math.round(pspClosed / pspTotal * 100) : 0;
            var pspDeptStr = [];
            (function(){ var m={}; probs.forEach(function(p){ var d=p.dept||'未知'; if(!m[d])m[d]={t:0,c:0}; m[d].t++; if(p.status==='已解决'||p.status==='Closed'||p.status==='แก้ไขแล้ว')m[d].c++; }); Object.keys(m).forEach(function(d){ pspDeptStr.push(d+':共'+m[d].t+'件,闭环'+m[d].c+'件,率'+Math.round(m[d].c/m[d].t*100)+'%'); }); })();
            
            const prompt = `【周期】${start} 至 ${end}
【异常总数】${pspTotal}件 | 【已闭环】${pspClosed}件 | 【闭环率】${pspCloseRate}%
【各部门闭环率】${pspDeptStr.join('; ')}

【异常明细】
${probs.join('\\n')}

请做【数据驱动分析】，输出HTML（不用Markdown，表格加class="ai-result-table"）：

一、周期内异常态势（基于数据）：
   - 日均异常数、闭环率总体趋势
   - 各部门闭环率排名（从高到低），标注低于80%的部门
   - 重复发生的异常（同描述出现2次+的条目及次数）

二、TOP焦点：按责任部门/车间归类，指出影响最大的3个部门及各自闭环表现

三、趋势判断：对比周期起止阶段的变化趋势

【红线】
- 禁止编造数据或添加未经数据支撑的结论
- 每条分析必须引用具体数字
- 语言：${currentLang}`;
            let ans = await callAI_API(prompt);
            btn.innerHTML = oldHtml; btn.disabled = false;
            if(ans) { document.getElementById('ai-result-content').innerHTML = ans; document.getElementById('ai-result-modal').style.display = 'flex'; }
        };
        window.aiAnalyzeLoss = async function(btn) {
            let start = document.getElementById('loss-ai-start').value; let end = document.getElementById('loss-ai-end').value;
            if(!start || !end) return;
            let oldHtml = btn.innerHTML; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 洞察中...`; btn.disabled = true;

            let losses = db.loss.filter(l => l.date >= start && l.date <= end);
            if(losses.length === 0) { btn.innerHTML = oldHtml; btn.disabled = false; return showToast('fa-solid fa-info-circle', `暂无LOSS记录`); }

            // 数据预处理:按部门、问题类型汇总
            let deptSummary = {};
            let eventTypeSummary = {};
            let totalLoss = 0;
            losses.forEach(l => {
                let qty = Math.abs(safeNum(l.qty));
                totalLoss += qty;
                let dept = l.dept || 'PE';
                if(!deptSummary[dept]) deptSummary[dept] = { count: 0, qty: 0, issues: [] };
                deptSummary[dept].count++;
                deptSummary[dept].qty += qty;
                if(l.desc) deptSummary[dept].issues.push(l.desc.substring(0, 30));
                let eventType = classifyEventType(l.desc || '');
                if(!eventTypeSummary[eventType]) eventTypeSummary[eventType] = { count: 0, qty: 0 };
                eventTypeSummary[eventType].count++;
                eventTypeSummary[eventType].qty += qty;
            });

            let deptRanking = Object.entries(deptSummary).map(([dept, data]) => ({ dept, count: data.count, qty: data.qty, samples: data.issues.slice(0, 3) })).sort((a, b) => b.qty - a.qty);
            let eventRanking = Object.entries(eventTypeSummary).map(([type, data]) => ({ type, count: data.count, qty: data.qty })).sort((a, b) => b.qty - a.qty);
            let topIssues = losses.map(l => ({ date: l.date, line: l.line, shift: l.shift, desc: l.desc, qty: Math.abs(safeNum(l.qty)), dept: l.dept })).sort((a, b) => b.qty - a.qty).slice(0, 10);

            let lossDetails = losses.map(l => `[${l.date}] ${l.line} ${l.shift}班: ${l.desc} (LOSS: ${l.qty}) [部门: ${l.dept}]`).join('\\n');

                        // ★ V2优化：数据驱动分析（90%数据+10%洞察）+ 同比环比
            var lossTotalQty = totalLoss;
            var lossCount = losses.length;
            var lossAvg = lossCount > 0 ? (lossTotalQty / lossCount).toFixed(1) : 0;
            var deptCount = Object.keys(deptSummary).length;
            // 统计重复问题
            var lossDescFreq = {};
            losses.forEach(function(l){ if(l.desc) { var k=String(l.desc||'').trim().slice(0,40); lossDescFreq[k]=(lossDescFreq[k]||0)+1; } });
            var repeatItems = Object.keys(lossDescFreq).filter(function(k){return lossDescFreq[k]>=2;}).length;
            
            const prompt = `【数据概览】周期${start}-${end} | LOSS总量:${lossTotalQty}件 | 发生${lossCount}次 | 平均${lossAvg}件/次 | 涉及${deptCount}个部门 | 重复问题类型${repeatItems}种

【部门排名】
${deptRanking.map(function(d,i){return (i+1)+'. '+d.dept+': 损失'+d.qty+'件, 发生'+d.count+'次';}).join('\n')}

【事件类型排名】
${eventRanking.map(function(e,i){return (i+1)+'. '+e.type+': 损失'+e.qty+'件, 发生'+e.count+'次';}).join('\n')}

【TOP10问题】
${topIssues.map(function(t,i){return (i+1)+'. ['+t.date+'] '+t.desc+' (损失:'+t.qty+', 部门:'+t.dept+')';}).join('\n')}

请做【数据驱动分析】，输出HTML（不用Markdown，表格加class="ai-result-table"）：

一、数据概览：总LOSS量、发生次数、平均损失、涉及部门数、问题类型分布

二、部门透视：
   按损失数量排序的部门排名表，标注贡献最大的Top3部门及占比
   各部门高频问题特征

三、问题频谱：
   高频问题（≥3次）清单
   高影响事件（单次≥10件）清单
   重复问题模式识别（相同或相似描述出现2次+）

四、趋势与对比：
   如提供前期数据则做对比；否则基于周期内的日/周趋势判断

【红线】
- 严禁编造数据
- 所有结论必须引用具体数字`;
            let ans = await callAI_API(prompt);
            btn.innerHTML = oldHtml; btn.disabled = false;
            if(ans) { document.getElementById('ai-result-content').innerHTML = ans; document.getElementById('ai-result-modal').style.display = 'flex'; }
        };
        window.aiIntelligentSummary = async function(btn) {
            let start = document.getElementById('loss-ai-start').value;
            let end = document.getElementById('loss-ai-end').value;
            if(!start || !end) {
                showToast('fa-solid fa-exclamation-triangle', '请选择时间范围', 'error');
                return;
            }

            let oldHtml = btn.innerHTML;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 智能总结中...`;
            btn.disabled = true;

            // 获取LOSS数据
            let losses = db.loss.filter(l => l.date >= start && l.date <= end);
            if(losses.length === 0) {
                btn.innerHTML = oldHtml;
                btn.disabled = false;
                showToast('fa-solid fa-info-circle', '所选时间段内暂无LOSS记录');
                return;
            }

            // 数据统计
            let totalLoss = 0;
            let deptSummary = {};
            let lineSummary = {};
            let typeSummary = {};
            let allIssues = [];

            losses.forEach(l => {
                let qty = Math.abs(safeNum(l.qty));
                totalLoss += qty;
                let dept = l.dept || 'PE';
                let line = l.line || '未知';
                let desc = l.desc || '';

                // 部门统计
                if(!deptSummary[dept]) deptSummary[dept] = { count: 0, qty: 0, issues: [] };
                deptSummary[dept].count++;
                deptSummary[dept].qty += qty;
                deptSummary[dept].issues.push(desc);

                // 线体统计
                if(!lineSummary[line]) lineSummary[line] = { count: 0, qty: 0 };
                lineSummary[line].count++;
                lineSummary[line].qty += qty;

                // 问题类型统计
                let problemType = classifyLossType(desc);
                if(!typeSummary[problemType]) typeSummary[problemType] = { count: 0, qty: 0 };
                typeSummary[problemType].count++;
                typeSummary[problemType].qty += qty;

                // 收集所有问题
                allIssues.push({ desc, qty, line, dept, date: l.date, shift: l.shift });
            });

            // TOP10影响数量的具体问题
            let top10Issues = allIssues.sort((a, b) => b.qty - a.qty).slice(0, 10);

            // TOP3影响最大的问题类型(按损失数量)
            let top3LossTypes = Object.entries(typeSummary)
                .sort((a, b) => b[1].qty - a[1].qty)
                .slice(0, 3);

            // TOP3最频繁的问题类型(按发生次数)
            let top3FrequentTypes = Object.entries(typeSummary)
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 3);

            // 部门责任排名
            let deptRanking = Object.entries(deptSummary)
                .sort((a, b) => b[1].qty - a[1].qty);

            // 线体影响排名
            let lineRanking = Object.entries(lineSummary)
                .sort((a, b) => b[1].qty - a[1].qty);

            // ★ 80%数据驱动分析 + 20%精益/生产/压缩机专业建议
                        // ★ V2优化：90%数据驱动 + 10%GMCC精益洞察 · 同比环比方向
            const prompt = `【数据全景】
周期: ${start} ~ ${end}
总LOSS量: ${totalLoss} 套 | 记录数: ${losses.length} 条 | 平均: ${(totalLoss / losses.length).toFixed(1)} 套/条

【TOP问题(按损失)】
${top10Issues.map(function(issue, i){ return (i+1)+'. "'+issue.desc+'" '+issue.qty+'套 ['+issue.line+' '+issue.shift+'班 '+issue.dept+']'; }).join('\n')}

【TOP3问题类型(按损失)】
${top3LossTypes.map(function(t, i){ return (i+1)+'. '+t[0]+' -> '+t[1].qty+'套('+t[1].count+'次)'; }).join('\n')}

【TOP3类型(按频次)】
${top3FrequentTypes.map(function(t, i){ return (i+1)+'. '+t[0]+' -> '+t[1].count+'次('+t[1].qty+'套)'; }).join('\n')}

【部门排名(按损失)】
${deptRanking.map(function(d, i){ return (i+1)+'. '+d[0]+' -> '+d[1].qty+'套('+d[1].count+'次)'; }).join('\n')}

【线体排名(按损失)】
${lineRanking.map(function(l, i){ return (i+1)+'. '+l[0]+' -> '+l[1].qty+'套('+l[1].count+'次)'; }).join('\n')}

请做数据驱动分析，输出HTML格式，表格加class="ai-result-table"：

【报告结构】
1. 总体罗盘：一句概述周期LOSS表现，突出总损失、平均损失、最多发部门
2. 核心发现：TOP3数据事实，每个事实包括【现象→影响量→趋势】
3. 归因聚焦：不超过3点，基于数据特征的推理（不是猜测）

【红线】
- 严禁编造数据
- 所有结论必须有数据支撑
- 语言: ${currentLang}`;

            try {
                let ans = await callAI_API(prompt);
                if(ans) {
                    document.getElementById('ai-result-content').innerHTML = ans;
                    document.getElementById('ai-result-modal').style.display = 'flex';
                    // 更新模态框标题
                    let modalTitle = document.querySelector('#ai-result-modal .modal-overlay h3');
                    if (modalTitle) modalTitle.textContent = 'AI智能总结报告';
                    showToast('fa-solid fa-check', 'AI智能总结完成');
                }
            } catch (error) {
                console.error('AI分析错误:', error);
                showToast('fa-solid fa-exclamation-triangle', 'AI分析失败,请重试', 'error');
            } finally {
                btn.innerHTML = oldHtml;
                btn.disabled = false;
            }
        };

        // LOSS问题类型分类函数
        function classifyLossType(desc) {
            let text = desc.toLowerCase();
            if (text.includes('设备') || text.includes('机器') || text.includes('故障') || text.includes('停机')) return '设备故障';
            if (text.includes('物料') || text.includes('零件') || text.includes('缺料') || text.includes('供应')) return '物料短缺';
            if (text.includes('质量') || text.includes('不良') || text.includes('缺陷') || text.includes('不合格')) return '质量问题';
            if (text.includes('人员') || text.includes('操作') || text.includes('培训') || text.includes('技能')) return '人员操作';
            if (text.includes('工艺') || text.includes('参数') || text.includes('标准') || text.includes('规范')) return '工艺参数';
            if (text.includes('计划') || text.includes('排产') || text.includes('调度')) return '生产计划';
            if (text.includes('测试') || text.includes('检测') || text.includes('检验')) return '测试检验';
            if (text.includes('安全') || text.includes('事故') || text.includes('伤害')) return '安全事故';
            return '其他问题';
        }

        // ================= 紧凑报告生成(LOSS页面) =================
        window._crData = null;

        // ★ 打开粘贴重复LOSS弹窗（在海报框内）
        window.openPasteRepeatUI = function() {
            var modal = document.getElementById('cr-paste-modal');
            if (!modal) { showToast('fa-solid fa-xmark', '弹窗DOM未找到', 'error'); return; }
            var ta = document.getElementById('cr-paste-input');
            if (ta) { ta.value = ''; ta.focus(); }
            modal.style.display = 'block';
        };
        window.closePasteRepeatUI = function() {
            var modal = document.getElementById('cr-paste-modal');
            if (modal) modal.style.display = 'none';
        };

        // ★ 本地Bigram分析（一键替代AI）
        window.runLocalBigramCr = function() {
            var ctx = window._crPasteCtx;
            if (!ctx || !ctx.losses || ctx.losses.length === 0) {
                showToast('fa-solid fa-exclamation-triangle', '请先生成紧凑报告', 'error');
                return;
            }
            var cSection = document.getElementById('cr-section-c');
            if (!cSection) { showToast('fa-solid fa-exclamation-triangle', '未找到C节区域', 'error'); return; }

            try {
                var _biItems = window._crCalcRepeatByBigram(ctx.losses, ctx.prevLosses);
                var cHtml = '<div class="cr-section-title">C. Repeat LOSS Analysis — ' + ctx.start + ' vs ' + ctx._prevDate + '</div>';
                var _mappedItems = [];
                var _biCurTotal = 0, _biPrevTotal = 0;
                _biItems.forEach(function(bi) {
                    var wt = 0;
                    (ctx.weeklyData||[]).forEach(function(wl) {
                        var d = String(wl.desc||'').trim();
                        if (d && window._crBigramSim(bi.desc, d) >= 0.75) wt += Math.abs(safeNum(wl.qty));
                    });
                    _mappedItems.push({
                        Issue: bi.desc,
                        Today_Count: bi.curQty,
                        Prev_Count: bi.prevQty,
                        Weekly_Total: wt
                    });
                    _biCurTotal += bi.curQty;
                    _biPrevTotal += bi.prevQty;
                });
                if (_mappedItems.length > 0) {
                    cHtml += window._crRenderRepeatSection(_biCurTotal, _biPrevTotal, ctx._prevDate, _mappedItems, 'Bigram Similarity (Local Algorithm)');
                } else {
                    cHtml += '<div style="padding:12px;text-align:center;color:#64748b;font-size:13px;">未检测到重复LOSS（Bigram本地分析未发现重复）</div>';
                }
                cSection.innerHTML = cHtml;
                showToast('fa-solid fa-check', '本地Bigram分析完成');
            } catch(e) {
                cSection.innerHTML = '<div class="cr-section-title">C. Repeat LOSS Analysis</div><div style="padding:12px;text-align:center;color:#dc2626;font-size:13px;">Bigram分析错误: ' + e.message + '</div>';
            }
        };

        // ★ 核心：解析粘贴的外部AI结果并渲染C节
        window.parsePastedRepeatLoss = function(opts) {
            opts = opts || {};
            if (opts.forceBigram) {
                window.runLocalBigramCr();
                return;
            }

            var ta = document.getElementById('cr-paste-input');
            if (!ta || !ta.value.trim()) {
                showToast('fa-solid fa-exclamation-triangle', '请先粘贴外部AI分析结果', 'error');
                return;
            }
            var raw = ta.value.trim();
            var ctx = window._crPasteCtx;
            if (!ctx) { showToast('fa-solid fa-exclamation-triangle', '请先生成紧凑报告', 'error'); return; }

            var cSection = document.getElementById('cr-section-c');
            if (!cSection) { showToast('fa-solid fa-exclamation-triangle', '未找到C节区域', 'error'); return; }

            var btn = document.getElementById('btn-parse-repeat');
            if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 解析中...'; btn.disabled = true; }

            try {
                var items = _autoParseCrInput(raw);
                if (!items || items.length === 0) {
                    showToast('fa-solid fa-exclamation-triangle', '未能从粘贴内容中解析出数据，请检查格式', 'error');
                    if (btn) { btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 解析并渲染'; btn.disabled = false; }
                    return;
                }

                var totalToday = 0, totalPrev = 0, repeatCount = 0;
                items.forEach(function(item) {
                    totalToday += item.Today_Count;
                    totalPrev += item.Prev_Count;
                    if (item.Prev_Count > 0) repeatCount++;
                });

                var cHtml = '<div class="cr-section-title">C. Repeat LOSS Analysis — ' + ctx.start + ' vs ' + ctx._prevDate + '</div>';
                cHtml += window._crRenderRepeatSection(
                    totalToday, totalPrev, ctx._prevDate,
                    items,
                    'External AI Analysis (Pasted)'
                );
                cSection.innerHTML = cHtml;

                var modal = document.getElementById('cr-paste-modal');
                if (modal) modal.style.display = 'none';

                showToast('fa-solid fa-check', '已渲染 ' + items.length + ' 条重复LOSS分析');
            } catch(e) {
                showToast('fa-solid fa-xmark', '解析失败: ' + e.message, 'error');
                if (cSection) {
                    cSection.innerHTML = '<div class="cr-section-title">C. Repeat LOSS Analysis</div><div style="padding:12px;text-align:center;color:#dc2626;font-size:13px;">解析错误: ' + e.message + '</div>';
                }
            } finally {
                if (btn) { btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 解析并渲染'; btn.disabled = false; }
            }
        };

        // ★ 自动识别粘贴格式并解析为 items[]
        function _autoParseCrInput(raw) {
            // --- 策略1: JSON 数组 ---
            var jsonMatch = raw.match(/\[\s*\{[\s\S]*?\}\s*\]/);
            if (jsonMatch) {
                try {
                    var parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].Issue !== undefined) {
                        return parsed.map(function(item) {
                            return {
                                Issue: String(item.Issue || item.issue || item.问题 || item.desc || item.description || '').trim(),
                                Today_Count: typeof item.Today_Count === 'number' ? item.Today_Count : (typeof item.today_count === 'number' ? item.today_count : (typeof item.今日 === 'number' ? item.今日 : parseInt(item.Today_Count || item.today_count || item.今日 || 0) || 0)),
                                Prev_Count: typeof item.Prev_Count === 'number' ? item.Prev_Count : (typeof item.prev_count === 'number' ? item.prev_count : (typeof item.昨日 === 'number' ? item.昨日 : parseInt(item.Prev_Count || item.prev_count || item.昨日 || 0) || 0)),
                                Weekly_Total: typeof item.Weekly_Total === 'number' ? item.Weekly_Total : (typeof item.weekly_total === 'number' ? item.weekly_total : (typeof item.本周 === 'number' ? item.本周 : parseInt(item.Weekly_Total || item.weekly_total || item.本周 || 0) || 0))
                            };
                        });
                    }
                } catch(e) { /* 不是JSON，继续解析 */ }
            }

            // --- 策略2: Markdown 表格 ---
            var lines = raw.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
            var pipeLines = lines.filter(function(l) { return l.indexOf('|') >= 0 && l.replace(/[-\s|]/g,'').length > 0; });
            var dataPipeLines = pipeLines.filter(function(l) { return !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s)*\|?\s*$/.test(l); });

            if (dataPipeLines.length >= 2) {
                for (var pi = 1; pi < dataPipeLines.length; pi++) {
                    var cells0 = dataPipeLines[0].split('|').map(function(c) { return c.trim(); }).filter(Boolean);
                    var cells1 = dataPipeLines[pi].split('|').map(function(c) { return c.trim(); }).filter(Boolean);
                    if (cells1.length >= 2) {
                        var hasNums = cells1.some(function(c) { return /\d+/.test(c); });
                        if (hasNums) {
                            var result = [];
                            for (var r = pi; r < dataPipeLines.length; r++) {
                                var row = dataPipeLines[r].split('|').map(function(c) { return c.trim(); }).filter(Boolean);
                                if (row.length < 2) continue;
                                var issue = '', today = 0, prev = 0, weekly = 0;
                                var firstIsNum = /^\d+$/.test(row[0].replace(/[#.]/g,''));
                                var startIdx = firstIsNum ? 1 : 0;
                                if (row.length >= startIdx + 2) {
                                    issue = row[startIdx];
                                    var nums = [];
                                    for (var ci = startIdx + 1; ci < row.length; ci++) {
                                        var cv = parseFloat(row[ci].replace(/[,%\u2191\u2193\u2194NEW]/g,''));
                                        if (!isNaN(cv)) nums.push(cv);
                                    }
                                    today = nums[0] || 0;
                                    prev = nums[1] || 0;
                                    weekly = nums[2] || 0;
                                    if (issue && (today > 0 || prev > 0 || weekly > 0)) {
                                        result.push({ Issue: issue, Today_Count: today, Prev_Count: prev, Weekly_Total: weekly });
                                    }
                                }
                            }
                            if (result.length > 0) return result;
                        }
                    }
                }
            }

            // --- 策略3: CSV/Tab ---
            var csvResult = [];
            lines.forEach(function(line) {
                var parts = line.split('\t');
                if (parts.length < 2) parts = line.split(',');
                if (parts.length < 2) parts = line.split(/\s{2,}/);
                if (parts.length >= 2) {
                    var issue = String(parts[0] || '').replace(/^[\d#.]+\s*/, '').trim();
                    if (!issue || issue.length < 2) return;
                    var nums = [];
                    for (var pi2 = 1; pi2 < parts.length; pi2++) {
                        var cv = parseFloat(String(parts[pi2]).replace(/[,%\u2191\u2193\u2194NEW]/g,''));
                        if (!isNaN(cv)) nums.push(cv);
                    }
                    if (nums.length > 0 && issue.length > 1) {
                        csvResult.push({
                            Issue: issue,
                            Today_Count: nums[0] || 0,
                            Prev_Count: nums[1] || 0,
                            Weekly_Total: nums[2] || 0
                        });
                    }
                }
            });
            if (csvResult.length > 0) return csvResult;

            // --- 策略4: 自由文本 ---
            var freeResult = [];
            var pattern = /([\u0E00-\u0E7Fa-zA-Z\u0E01-\u0E39\s]{3,50}?)\s*[:\uFF1A]?\s*(?:\u4ECA\u65E5|[Tt]oday)\s*[:\uFF1A=]?\s*(\d+)\s*(?:\u6628\u65E5|[Pp]rev(?:ious)?)\s*[:\uFF1A=]?\s*(\d+)(?:\s*(?:\u672C\u5468|[Ww]eekly)\s*[:\uFF1A=]?\s*(\d+))?/g;
            var m;
            while ((m = pattern.exec(raw)) !== null) {
                freeResult.push({
                    Issue: m[1].trim(),
                    Today_Count: parseInt(m[2]) || 0,
                    Prev_Count: parseInt(m[3]) || 0,
                    Weekly_Total: parseInt(m[4]) || 0
                });
            }
            if (freeResult.length > 0) return freeResult;

            return null;
        }

        // ★ 同一天内相同描述的LOSS合并（白班+夜班同问题合并为1条）（白班+夜班同问题合并为1条）
        function _crMergeByDesc(arr) {
            var map = {}, result = [];
            arr.forEach(function(l) {
                var d = (l.desc || '').trim();
                if (!d) return;
                if (!map[d]) {
                    map[d] = { desc: d, qty: 0, dept: l.dept || 'Other', line: l.line || '', shift: l.shift || '', date: l.date };
                    result.push(map[d]);
                }
                map[d].qty += Math.abs(safeNum(l.qty));
            });
            return result;
        }
        
        // ★ AI 配置
        var _AI_API_BASE = AI_URL;
        function _getSelectedModel() {
            var sel = document.getElementById('ai-model-selector');
            return sel ? sel.value : 'THUDM/GLM-4-9B-0414';
        }
        
        // ★ 单次全量 AI 对比分析：一次发送今日/昨日/本周数据，AI直接输出最终报表
        window._aiDirectCompare = async function(todayData, yesterdayData, weeklyData) {
            // 提取原始描述（去空），作为JSON数组发送
            var todayList = [];
            var seenToday = {};
            todayData.forEach(function(l) {
                var d = (l.desc || '').trim();
                if (d && !seenToday[d]) { seenToday[d] = true; todayList.push(d); }
            });
            var yesterdayList = [];
            var seenYes = {};
            yesterdayData.forEach(function(l) {
                var d = (l.desc || '').trim();
                if (d && !seenYes[d]) { seenYes[d] = true; yesterdayList.push(d); }
            });
            var weeklyList = [];
            var seenWk = {};
            weeklyData.forEach(function(l) {
                var d = (l.desc || '').trim();
                if (d && !seenWk[d]) { seenWk[d] = true; weeklyList.push(d); }
            });

            var prompt = '【指令】根据今日(Today_List)、昨日(Yesterday_List)、本周(Weekly_List)的异常事件描述，输出重复LOSS分析JSON。\n';
            prompt += '合并规则：描述相似即视为同一事件（如泰语变体、同一设备同一报警、同一工位同一故障）。\n';
            prompt += '\n';
            prompt += 'Today_List: ' + JSON.stringify(todayList) + '\n';
            prompt += 'Yesterday_List: ' + JSON.stringify(yesterdayList) + '\n';
            prompt += 'Weekly_List: ' + JSON.stringify(weeklyList) + '\n';
            prompt += '\n';
            prompt += '【输出格式】严格JSON数组，每项: {\"Issue\":\"问题标准描述(泰语)\",\"Today_Count\":N,\"Prev_Count\":N,\"Weekly_Total\":N}';

            try {
                var _sysPrompt = '你是一个数据格式化工具。你的唯一任务是将输入数据整理输出为严格JSON数组格式。绝对不要输出任何其他文字、解释、代码块标记或Markdown。';
                var content = await callAI_API(prompt, 0, _sysPrompt, 4096);
                if (!content) return { success: false, error: 'AI API call failed (null response)' };
                // 多策略提取 JSON 数组
                function _extractJSONArray(str) {
                    // 策略1: 尝试直接 JSON.parse
                    try { var p = JSON.parse(str); if (Array.isArray(p)) return p; } catch(e) {}
                    // 策略2: 尝试提取 ```json ... ``` 或 ``` ... ``` 代码块
                    var cb = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                    if (cb) { try { var p = JSON.parse(cb[1].trim()); if (Array.isArray(p)) return p; } catch(e) {} }
                    // 策略3: 查找 [ 到最后一个 ] 之间的所有内容
                    var firstBracket = str.indexOf('[');
                    var lastBracket = str.lastIndexOf(']');
                    if (firstBracket !== -1 && lastBracket > firstBracket) {
                        var candidate = str.substring(firstBracket, lastBracket + 1);
                        try { var p = JSON.parse(candidate); if (Array.isArray(p)) return p; } catch(e) {}
                    }
                    // 策略4: (原版) 匹配 [{...}] 模式
                    var m = str.match(/\[\s*\{[\s\S]*?\}\s*\]/);
                    if (m) { try { var p = JSON.parse(m[0]); if (Array.isArray(p)) return p; } catch(e) {} }
                    return null;
                }
                var parsed = _extractJSONArray(content);
                if (!parsed) return { success: false, error: 'No JSON array in response' };
                // 验证每个条目有必填字段
                var validItems = [];
                parsed.forEach(function(item) {
                    if (item.Issue) {
                        validItems.push({
                            Issue: String(item.Issue).trim(),
                            Today_Count: typeof item.Today_Count === 'number' ? item.Today_Count : parseInt(item.Today_Count) || 0,
                            Prev_Count: typeof item.Prev_Count === 'number' ? item.Prev_Count : parseInt(item.Prev_Count) || 0,
                            Weekly_Total: typeof item.Weekly_Total === 'number' ? item.Weekly_Total : parseInt(item.Weekly_Total) || 0
                        });
                    }
                });
                // 计算总计
                var totalToday = 0, totalPrev = 0, repeatItems = 0;
                validItems.forEach(function(item) {
                    totalToday += item.Today_Count;
                    totalPrev += item.Prev_Count;
                    if (item.Prev_Count > 0) repeatItems++;
                });
                return {
                    success: true,
                    items: validItems,
                    totalCur: totalToday,
                    totalPrev: totalPrev,
                    repeatCount: repeatItems
                };
            } catch(e) {
                return { success: false, error: e.message || 'Unknown error' };
            }
        };

        // ★ 全局Bigram相似度算法（用于紧凑报告C节）
        window._crSafeStr = function(s) { return String(s||'').trim().toLowerCase(); };
        window._crBigramSim = function(a, b) {
            a = window._crSafeStr(a); b = window._crSafeStr(b);
            if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
            var bgA = {};
            for (var i = 0; i < a.length - 1; i++) { var bg = a.substring(i, i+2); bgA[bg] = (bgA[bg]||0) + 1; }
            var inter = 0;
            for (var i = 0; i < b.length - 1; i++) { var bg = b.substring(i, i+2); if (bgA[bg] > 0) { bgA[bg]--; inter++; } }
            var union = Math.max(a.length, b.length) - 1;
            return union > 0 ? inter / union : 0;
        };
        window._crCalcRepeatByBigram = function(curLosses, prevLosses) {
            var items = [];
            var SIM = 0.75;
            curLosses.forEach(function(cur, idx_) {
                if (!cur || !cur.desc) return;
                var curDesc = String(cur.desc).trim();
                var bestMatch = null;
                var bestSim = 0;
                prevLosses.forEach(function(prev) {
                    if (!prev || !prev.desc) return;
                    var sim = window._crBigramSim(curDesc, String(prev.desc).trim());
                    if (sim > bestSim) { bestSim = sim; bestMatch = prev; }
                });
                if (bestSim >= SIM && bestMatch) {
                    var _bQty = Math.abs(safeNum(cur.qty));
                    var _bpQty = Math.abs(safeNum(bestMatch.qty));
                    items.push({
                        curIdx: idx_,
                        desc: curDesc,
                        prevDesc: String(bestMatch.desc).trim(),
                        curQty: _bQty,
                        prevQty: _bpQty,
                        dept: cur.dept || 'Other',
                        similarity: Math.round(bestSim * 100)
                    });
                }
            });
            return items;
        };
        window._crRenderRepeatSection = function(curTotal, prevTotal, prevDate, items, methodLabel) {
            var h = '';
            h += '<div style="padding: 2px 0;">';
            if (items.length > 0) {
                var sortedItems = items.slice().sort(function(a, b) { return b.Today_Count - a.Today_Count; });
                h += '<table class="cr-table cr-table-compact" style="margin-bottom:2px;table-layout:fixed;">';
                h += '<tr><th style="width:8%;text-align:center;padding:3px 4px;font-size:10px;">#</th><th style="width:30%;padding:3px 4px;font-size:10px;">Issue</th><th style="width:15%;text-align:right;padding:3px 4px;font-size:10px;">Today</th><th style="width:15%;text-align:right;padding:3px 4px;font-size:10px;">Prev</th><th style="width:17%;text-align:right;padding:3px 4px;font-size:10px;">Weekly</th><th style="width:15%;text-align:center;padding:3px 4px;font-size:10px;">Trend</th></tr>';
                sortedItems.slice(0, 8).forEach(function(item, rankIdx) {
                    var trendHtml = '';
                    if (item.Today_Count > item.Prev_Count) trendHtml = '<span style="color:#dc2626;font-size:18px;font-weight:900;">\u2191</span>';
                    else if (item.Today_Count < item.Prev_Count) trendHtml = '<span style="color:#16a34a;font-size:18px;font-weight:900;">\u2193</span>';
                    else if (item.Today_Count === 0 && item.Prev_Count === 0) trendHtml = '<span style="color:#dc2626;font-size:11px;font-weight:900;border:1px solid #dc2626;border-radius:2px;padding:0px 3px;">NEW</span>';
                    else trendHtml = '<span style="color:#d97706;font-size:16px;font-weight:900;">\u2194</span>';
                    h += '<tr>';
                    h += '<td style="text-align:center;font-weight:700;color:#6b7280;font-size:10px;padding:1px 3px;">' + (rankIdx + 1) + '</td>';
                    h += '<td style="font-size:10px;font-weight:600;word-break:break-word;white-space:normal;line-height:1.2;padding:1px 3px;">' + (item.Issue || '').replace(/"/g,'&quot;') + '</td>';
                    h += '<td style="text-align:right;font-weight:700;color:#dc2626;font-size:10px;padding:1px 3px;">' + item.Today_Count + '</td>';
                    h += '<td style="text-align:right;font-weight:700;color:#64748b;font-size:10px;padding:1px 3px;">' + item.Prev_Count + '</td>';
                    h += '<td style="text-align:right;font-weight:700;color:#7c3aed;font-size:10px;padding:1px 3px;">' + item.Weekly_Total + '</td>';
                    h += '<td style="text-align:center;font-size:12px;font-weight:900;padding:1px 3px;">' + trendHtml + '</td>';
                    h += '</tr>';
                });
                if (sortedItems.length > 8) {
                    h += '<tr><td colspan="6" style="text-align:center;color:#9ca3af;font-size:10px;padding:1px 3px;">... and ' + (sortedItems.length - 8) + ' more items</td></tr>';
                }
                h += '</table>';
            } else {
                h += '<div style="text-align:center;padding:6px;background:#f0fdf4;border-radius:6px;border:1px dashed #86efac;margin-bottom:2px;">';
                h += '<i class="fa-solid fa-check-circle" style="color:#16a34a;font-size:20px;"></i>';
                h += '<div style="font-size:11px;font-weight:700;color:#166534;margin-top:2px;">No Repeat LOSS Detected</div>';
                h += '<div style="font-size:10px;color:#4ade80;margin-top:1px;">All unique issues vs ' + prevDate + '</div>';
                h += '</div>';
            }
            h += '</div>';
            return h;
        };

        // ★ 辅助函数：获取前一天的日期字符串 YYYY-MM-DD
        function _formatPrevDate(dateStr) {
            if (!dateStr || String(dateStr).length < 10) return '';
            var d = new Date(dateStr + 'T00:00:00');
            d.setDate(d.getDate() - 1);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        }
        window.generateLossCompactReport = function() {
            let start = document.getElementById('loss-ai-start').value;
            let end = document.getElementById('loss-ai-end').value;
            if(!start || !end) {
                showToast('fa-solid fa-exclamation-triangle', '请先选择时间范围', 'error');
                return;
            }
            let losses = db.loss.filter(l => l.date >= start && l.date <= end);
            if(losses.length === 0) {
                showToast('fa-solid fa-info-circle', '所选时间段内暂无LOSS记录');
                return;
            }
            // 按线体+班次分类
            let lineShiftData = {};
            let deptData = {};
            let totalQty = 0;
            losses.forEach(function(l) {
                var qty = Math.abs(safeNum(l.qty));
                totalQty += qty;
                var lineKey = l.line || 'Unknown';
                var shiftKey = l.shift === 'D' ? 'Day' : (l.shift === 'N' ? 'Night' : 'Any');
                if(!lineShiftData[lineKey]) lineShiftData[lineKey] = {};
                if(!lineShiftData[lineKey][shiftKey]) lineShiftData[lineKey][shiftKey] = [];
                lineShiftData[lineKey][shiftKey].push({ desc: l.desc || '', qty: qty, date: l.date });
                // 部门统计
                var dept = l.dept || '其他';
                if(!deptData[dept]) deptData[dept] = 0;
                deptData[dept] += qty;
            });
            // 按线体排序
            var lineOrder = ['LINE A','LINE B','LINE C','LINE D'];
            var sortedLines = lineOrder.filter(function(l) { return lineShiftData[l]; });
            var otherLines = Object.keys(lineShiftData).filter(function(l) { return lineOrder.indexOf(l) === -1; }).sort();
            sortedLines = sortedLines.concat(otherLines);

            // 智能日期显示：单日只写一个日期，范围写跨度
            function _fmtDateRange(s, e) {
                if (s === e) return s;
                return s + ' ~ ' + e;
            }
            var _displayDate = _fmtDateRange(start, end);
            // 构建报告HTML - 双栏布局
            var html = '';
            html += '<div class="cr-content" id="cr-content-inner">';
            html += '<div class="cr-title">' + _displayDate + ' LOSS Daily Brief Report</div>';
            html += '<div class="cr-subtitle"><span style="font-size:18px;font-weight:900;color:#dc2626;">Total LOSS: ' + totalQty + ' units</span> &nbsp;|&nbsp; Records: ' + losses.length + '</div>';
            html += '<div class="cr-two-col">';
            // ========== 左栏 (2/3): A. 线体与班次明细 ==========
            html += '<div class="cr-left">';
            html += '<div class="cr-section-title">A. Line & Shift Details</div>';
            for(var li = 0; li < sortedLines.length; li++) {
                var line = sortedLines[li];
                var shifts = lineShiftData[line];
                var lineTotal = 0;
                var shiftKeys = Object.keys(shifts);
                for(var si = 0; si < shiftKeys.length; si++) {
                    var items = shifts[shiftKeys[si]];
                    for(var ii = 0; ii < items.length; ii++) { lineTotal += items[ii].qty; }
                }
                html += '<div class="cr-line-block">';
                html += '<div class="cr-line-header"><span>' + line + '</span><span>Total: ' + lineTotal + '</span></div>';
                var shiftOrder = shiftKeys.indexOf('Day') !== -1 ? ['Day','Night'] : shiftKeys;
                for(var si = 0; si < shiftOrder.length; si++) {
                    var sk = shiftOrder[si];
                    if(!shifts[sk]) continue;
                    var items = shifts[sk];
                    html += '<div class="cr-shift-block">';
                    html += '<div class="cr-shift-header">' + sk + ' Shift (' + items.length + ' records)</div>';
                    // Sort items by qty descending
                    items.sort(function(a,b) { return b.qty - a.qty; });
                    for(var ii = 0; ii < items.length; ii++) {
                        var it = items[ii];
                        html += '<div class="cr-item"><span class="cr-qty">' + it.qty + '</span><span class="cr-desc">' + it.desc + '</span></div>';
                    }
                    html += '</div>';
                }
                html += '</div>';
            }
            html += '</div>';
            // ========== 分隔线 ==========
            html += '<div class="cr-divider"></div>';
            // ========== 右栏 (1/3): B.部门排名柱状图 + C.核心总结 ==========
            html += '<div class="cr-right">';

            // b. 责任部门损失统计 - 柱状图版本
            html += '<div class="cr-section">';
            html += '<div class="cr-section-title">B. Department Loss Ranking</div>';

            var deptSorted = Object.keys(deptData).sort(function(a,b) { return deptData[b] - deptData[a]; });
            var maxDeptQtyValue = deptSorted.length > 0 ? deptData[deptSorted[0]] : 1;

                        // 柱状图容器 - 显示所有部门
            html += '<div class="cr-chart-container">';
            var barColors = ['#dc2626','#ea580c','#d97706','#65a30d','#0284c7','#7c3aed','#0891b2','#9333ea','#0d9488','#b91c1c','#c2410c','#a16207'];
            for(var di = 0; di < deptSorted.length; di++) {
                var dk = deptSorted[di];
                var qty = deptData[dk];
                var percentage = maxDeptQtyValue > 0 ? (qty / maxDeptQtyValue * 100) : 0;
                var barWidth = Math.max(4, (percentage / 100) * 100) + '%';
                var barColor = barColors[di % barColors.length];

                html += '<div class="cr-bar-item">';
                html += '<div class="cr-bar-label">' + dk + '</div>';
                html += '<div class="cr-bar-wrapper">';
                html += '<div class="cr-bar" style="width:' + barWidth + '; background:' + barColor + '; box-shadow: 0 1px 3px ' + barColor + '66;"></div>';
                html += '<div class="cr-bar-value" style="color:' + barColor + ';">' + qty + '</div>';
                html += '</div>';
                html += '</div>';
            }
            html += '</div>'; // chart-container结束

            // Calculate MTD (Month-To-Date) for each department
            var currentMonth = start.substring(0, 7);
            var monthLosses = db.loss.filter(function(l) {
                return l.date && String(l.date).startsWith(currentMonth);
            });
            var deptMTD = {};
            monthLosses.forEach(function(l) {
                var dept = l.dept || 'Other';
                if(!deptMTD[dept]) deptMTD[dept] = 0;
                deptMTD[dept] += Math.abs(safeNum(l.qty));
            });
            var totalMTD = 0;
            for(var dk in deptMTD) { if(deptMTD.hasOwnProperty(dk)) totalMTD += deptMTD[dk]; }

            // 获取本月所有出现过的部门（按MTD降序排列），以显示完整清单
            var allDepts = Object.keys(deptMTD).sort(function(a,b) {
                return (deptMTD[b]||0) - (deptMTD[a]||0);
            });

            // 表格版本 - Dept | Today | Monthly Total | %(月累计占比)
            html += '<div style="font-size:10px;color:#64748b;margin-bottom:2px;font-style:italic;">Today Impact Ranking (bar chart above)</div>';
            html += '<table class="cr-table" style="margin-top:6px;">';
            html += '<tr><th>Dept</th><th style="text-align:right;">Today</th><th style="text-align:right;">Monthly<br>Total</th><th style="text-align:right;">%</th></tr>';
            for(var di = 0; di < allDepts.length; di++) {
                var dk = allDepts[di];
                var qty = deptData[dk] || 0;
                var mtdQty = deptMTD[dk] || 0;
                var percentage = totalMTD > 0 ? ((mtdQty / totalMTD) * 100).toFixed(1) : '0.0';
                html += '<tr><td>' + dk + '</td><td style="text-align:right;">' + qty + '</td><td style="text-align:right;">' + mtdQty + '</td><td style="text-align:right;">' + percentage + '%</td></tr>';
            }

            html += '<tr class="cr-total-row"><td>Total</td><td style="text-align:right;"><strong>' + totalQty + '</strong></td><td style="text-align:right;"><strong>' + totalMTD + '</strong></td><td style="text-align:right;">100%</td></tr>';
            html += '</table>';
            html += '</div>'; // section结束

            // c. 重复LOSS分析（对比前一天）— AI驱动 + Bigram回退
            var _prevDate = _formatPrevDate(start);
            var _prevLosses = (db.loss || []).filter(function(l) { return l.date === _prevDate; });


            // --- 初始化：显示粘贴区域（替代原来的AI加载占位） ---
            var _wkStart = (function(dStr) {
                var d = new Date(dStr + 'T00:00:00');
                var day = d.getDay();
                var diff = (day === 0 ? 6 : day - 1);
                d.setDate(d.getDate() - diff);
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            })(end);
            var _weeklyData = db.loss.filter(function(l) { return l.date >= _wkStart && l.date <= end; });

            window._crPasteCtx = {
                start: start, end: end, _prevDate: _prevDate,
                totalQty: totalQty, lossesCount: losses.length,
                losses: losses, prevLosses: _prevLosses, weeklyData: _weeklyData
            };

            var pasteCtaHtml = '<div class="cr-section" id="cr-section-c">';
            pasteCtaHtml += '<div class="cr-section-title">C. Repeat LOSS Analysis — ' + start + ' vs ' + _prevDate + '</div>';
            pasteCtaHtml += '<div style="padding:24px;text-align:center;background:#f8fafc;border-radius:8px;border:2px dashed #cbd5e1;margin:8px 0;">';
            pasteCtaHtml += '<i class="fa-solid fa-paste" style="font-size:28px;color:#6366f1;"></i>';
            pasteCtaHtml += '<div style="font-size:14px;font-weight:700;color:#1e293b;margin:8px 0 4px 0;">请粘贴外部AI分析的重复LOSS结果</div>';
            pasteCtaHtml += '<div style="font-size:11px;color:#94a3b8;margin-bottom:12px;">点击上方工具栏「粘贴重复LOSS」按钮，或使用本地Bigram算法自动分析</div>';
            pasteCtaHtml += '<button class="btn btn-ai" onclick="window.runLocalBigramCr()" style="padding:10px 24px;font-size:13px !important;"><i class="fa-solid fa-calculator"></i> 使用本地Bigram自动分析重复LOSS</button>';
            pasteCtaHtml += '</div></div>';

            html += pasteCtaHtml;
            html += '</div>'; // 右栏结束
            html += '</div>'; // 双栏结束
            html += '</div>';
            window._crData = { html: html, start: start, end: end, totalQty: totalQty };
            document.getElementById('compact-report-content').innerHTML = html;
            document.getElementById('compact-report-wrap').style.display = 'flex';
        };
        window.downloadCRImage = async function() {
            if(!window._crData) { showToast('fa-solid fa-exclamation-triangle', '请先生成报告', 'error'); return; }
            var content = document.getElementById('cr-content-inner');
            if(!content) { showToast('fa-solid fa-exclamation-triangle', '报告内容未找到', 'error'); return; }
            showToast('fa-solid fa-spinner fa-spin', '正在生成图片...');
            try {
                // 先临时加padding让边缘不挤
                content.style.padding = '4px 6px';
                var canvas = await html2canvas(content, {
                    scale: 2,
                    backgroundColor: '#ffffff',
                    useCORS: true,
                    logging: false,
                    width: content.scrollWidth,
                    height: content.scrollHeight
                });
                content.style.padding = '';
                var link = document.createElement('a');
                link.download = 'LOSS_Report_' + window._crData.start + '.png';
                link.href = canvas.toDataURL('image/png');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                showToast('fa-solid fa-check', '长图已下载');
            } catch(e) {
                console.error(e);
                showToast('fa-solid fa-xmark', '生成图片失败: ' + e.message, 'error');
            }
        };

        window.aiAnalyzeTrend = async function() {
            let span = document.getElementById('trendSpan').value; let metricSel = document.getElementById('trendMetric'); let metricLabel = metricSel.options[metricSel.selectedIndex].text;
            let btn = document.getElementById('btn-ai-trend'); let oldHtml = btn.innerHTML; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 分析中...`; btn.disabled = true;
            let selectedDate = window.safeDOM.val("globalDate");
            let dates = Object.keys(db.prod).filter(d => d <= selectedDate).sort();
            if(dates.length > parseInt(span)) dates = dates.slice(-parseInt(span));
            let dataSummary = [];
            dates.forEach(d => { let daily = { date: d.substring(5) }; PRO_ORDER.forEach(ws => { daily[ws] = calcWsData(d, ws)[document.getElementById('trendMetric').value] || 0; }); dataSummary.push(daily); });
                        // ★ V2优化：数据驱动趋势分析
            var trendPeriod = span;
            var trendLabel = metricLabel;
            var trendDataStr = JSON.stringify(dataSummary);
            // 计算起点和终点值
            var firstVal = dataSummary.length > 0 ? Object.values(dataSummary[0]).reduce(function(a,b){return a+(typeof b==='number'?b:0);},0) - dataSummary[0].date : 0;
            var lastVal = dataSummary.length > 0 ? Object.values(dataSummary[dataSummary.length-1]).reduce(function(a,b){return a+(typeof b==='number'?b:0);},0) - dataSummary[dataSummary.length-1].date : 0;
            var trendDir = lastVal > firstVal ? '上升' : (lastVal < firstVal ? '下降' : '持平');
            
            const prompt = `【${trendLabel}趋势分析】周期:过去${trendPeriod}天 | 趋势方向:${trendDir}
【数据摘要】${trendDataStr}

请做【数据驱动分析】，纯文本输出，语言:${currentLang}：

一、趋势概述：整体走势（上升/下降/波动），起止值变化幅度

二、异常波动点：识别数据中的异常峰值/谷值，指出对应的日期和车间/线体

三、车间对比：各车间表现差异，持续低迷或显著改善的车间

四、可能关联因素（仅基于数据模式推断，不做猜测）：
   - 是否与排产波动、设备稼动、质量返工、物料齐套、出勤变化等相关
   - 给出数据层面的关联证据，非臆测

【红线】
- 严禁编造数据
- 所有分析必须引用具体数字`;
            let ans = await callAI_API(prompt);
            btn.innerHTML = oldHtml; btn.disabled = false;
            if(ans) { let memoEl = document.getElementById('memoText'); memoEl.value = (memoEl.value ? memoEl.value + '\n\n' : '') + `[AI 数据洞察]:${ans}`; saveMemo(); showToast('fa-solid fa-check', '洞察完成'); }
        };
        window.generateAISummary = async function() {
            let btn = document.getElementById('btn-gen-ai'); let contentBox = document.getElementById('ai-summary-content');
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 生成中...`; contentBox.classList.add('ai-generating');
            let outTot = document.getElementById('rp-out-tot').innerText; let lossTot = document.getElementById('rp-loss-tot').innerText; let upphTot = document.getElementById('rp-upph-tot').innerText;
            let probInfo = db.problems.map(p => `[${p.dept}]${p.desc}(${p.status})`).join(';').substring(0, 300);
                        // ★ V2优化：数据驱动经营复盘
            const prompt = `【宏观经营数据】
- PRO2总产出: ${outTot}
- PRO2整体UPPH: ${upphTot}
- PRO2累计Missing Qty: ${lossTot}
- 异常概况: ${probInfo}

请做【数据驱动经营复盘】，输出HTML(<h3>,<ul>,<li>,<strong>)，无Markdown：

一、经营指标达成综述（基于数据）：
   产出、UPPH、出勤、DM/PSP闭环各指标的数值表现和趋势判断
   各指标之间的联动关系（如产出与LOSS的对应）

二、Missing Qty分析（基于数据）：
   对交付影响的程度评估
   从数据看瓶颈工序和班次稳定性

【红线】
- 严禁编造数据
- 每条结论必须引用具体数字`;
            let summary = await callAI_API(prompt);
            btn.innerHTML = `<i class="fa-solid fa-robot"></i> 重新生成`; contentBox.classList.remove('ai-generating');
            if(summary) { contentBox.innerHTML = summary; } else { contentBox.innerHTML = "生成失败"; }
        };
        // ================= 基础交互辅助与拖拽 =================
        window.handleDragOver = function(e) {
            e.preventDefault();
            // 仅在数据录入页面显示拖拽区
            var inputPage = document.getElementById('p-input');
            if (inputPage && !inputPage.classList.contains('active')) return;
            document.getElementById('drop-zone').style.display = 'flex';
        };
        window.handleDragLeave = function(e) { e.preventDefault(); document.getElementById('drop-zone').style.display = 'none'; };
        window.handleDrop = function(e) {
            e.preventDefault();
            document.getElementById('drop-zone').style.display = 'none';
            // 仅在数据录入页面处理拖入文件
            var inputPage = document.getElementById('p-input');
            if (inputPage && !inputPage.classList.contains('active')) return;
            if(e.dataTransfer.files.length > 0) processFileToAI(e.dataTransfer.files[0]);
        };
        window.handleExcelImport = function(input) { if(input.files.length > 0) { processFileToAI(input.files[0]); input.value = ''; } };
        function processFileToAI(file) {
            showToast('fa-solid fa-spinner fa-spin', '读取中...');
            let reader = new FileReader();
            reader.onload = function(e) {
                try {
                    let data = new Uint8Array(e.target.result); let workbook = XLSX.read(data, {type: 'array'});
                    let csvText = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
                    document.getElementById('paste-modal').style.display = 'flex';
                    document.getElementById('pasteInput').value = csvText;
                    fastParseData(); // 优先触发极速解析
                } catch(err) { showToast('fa-solid fa-xmark', '格式错误', 'error'); }
            }; reader.readAsArrayBuffer(file);
        }
        async function executePureTranslation(text, langCode) {
            if(!text) return text;
            const tMap = {zh:'中文', en:'英文', th:'泰文(Thai)'};
            const prompt = `直接输出翻译结果,无解释。将此内容翻译为${tMap[langCode]}:\n${text}`;
            let trans = await callAI_API(prompt, 0, false); // translation task, no system prompt
        }
        window.aiTranslateAllProblems = async function(btn) { if(!btn) btn = document.querySelector('.btn-ai[onclick*="aiTranslateAllProblems"]'); if(!btn) return; if(btn.disabled) return; var oldHtml = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 翻译中...'; btn.disabled = true; try { var toT = (db.problems||[]).filter(function(p){ return p.desc && /[\u0E00-\u0E7F]/.test(p.desc); }); if(toT.length === 0) { showToast('fa-solid fa-info-circle', '未检测到泰语内容'); btn.innerHTML = oldHtml; btn.disabled = false; return; } var count = 0; for(var i = 0; i < toT.length; i++) { var orig = toT[i].desc; var t = await executePureTranslation(orig, 'zh'); if(t && t !== orig) { toT[i]._origDesc = toT[i]._origDesc || orig; toT[i].desc = t; count++; } } triggerAutoSave(); renderPDCA(); showToast('fa-solid fa-check', '已翻译 '+count+' 条'); } catch(e) { showToast('fa-solid fa-xmark', '翻译失败: '+e.message); } btn.innerHTML = oldHtml; btn.disabled = false; };
        window.aiTranslateLossProblems = async function(btn) { if(!btn) btn = document.querySelector('.btn-ai[onclick*="aiTranslateLossProblems"]'); if(!btn) return; if(btn.disabled) return; var oldHtml = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 翻译中...'; btn.disabled = true; try { var toT = (db.loss||[]).filter(function(p){ return p.desc && /[\u0E00-\u0E7F]/.test(p.desc); }); if(toT.length === 0) { showToast('fa-solid fa-info-circle', '未检测到泰语内容,无需翻译'); btn.innerHTML = oldHtml; btn.disabled = false; return; } var count = 0; for(var i = 0; i < toT.length; i++) { var originalDesc = toT[i].desc; var translated = await executePureTranslation(originalDesc, 'zh'); if(translated && translated !== originalDesc) { toT[i]._origDesc = toT[i]._origDesc || originalDesc; toT[i].desc = translated; count++; } } triggerAutoSave(); renderLoss(); showToast('fa-solid fa-check', '已翻译 '+count+' 条记录(按 CTRL+Z 可撤回至原始泰语)'); } catch(e) { showToast('fa-solid fa-xmark', '翻译失败: '+e.message); } btn.innerHTML = oldHtml; btn.disabled = false; };
        window.undoTranslateLoss = function() { var undone = 0; (db.loss||[]).forEach(function(p){ if(p._origDesc) { p.desc = p._origDesc; delete p._origDesc; undone++; } }); if(undone > 0) { triggerAutoSave(); renderLoss(); showToast('fa-solid fa-rotate-left', '已撤回 '+undone+' 条记录到原始泰语'); } else { showToast('fa-solid fa-info-circle', '没有可撤回的翻译记录'); } };
        window.aiTranslateMemo = async function() { let m = document.getElementById('memoText'); showToast('fa-solid fa-spinner fa-spin', '翻译中...'); let t = await executePureTranslation(m.value, currentLang); if(t) { m.value = t; saveMemo(); showToast('fa-solid fa-check', '完成'); } };
        window.aiSuggestCountermeasure = async function(id) { let p = db.problems.find(x => x.id == id); if(!p||!p.desc) return; showToast('fa-solid fa-spinner', '生成中...'); let a = await callAI_API(`异常:"${p.desc}"。基于数据做：1.【数据关联】(70%)该异常在数据中常见特征趋势；2.【模式分析】(20%)基于现有数据的模式识别；3.【方向提示】(10%)1句简要提示。仅结尾可加一句话建议。语言:${currentLang}`); if(a) { p.desc += ` | AI: ${a}`; triggerAutoSave(); renderPDCA(); showToast('fa-solid fa-check', '生成成功'); } };
        // ================= 视图渲染与协同管理 =================
        // 事件类型分类函数
        function classifyEventType(desc) {
            if (!desc) return '其他';
            const d = desc.toLowerCase();
            if (/故障|breakdown|เสีย|malfunction|报警|alarm/.test(d)) return '设备故障';
            if (/缺|สั้น|shortage|缺料|物料|material/.test(d)) return '物料短缺';
            if (/质量|品质|quality|NG|不良|defect/.test(d)) return '质量问题';
            if (/漏|泄漏|leak|气密|leakage/.test(d)) return '气密泄漏';
            if (/焊接|weld|เชื่อม/.test(d)) return '焊接异常';
            if (/参数|parameter|设定|setting/.test(d)) return '工艺参数';
            if (/操作|operator|失误|错误|error/.test(d)) return '人员操作';
            if (/等待|wait|รอ/.test(d)) return '等待停机';
            if (/测试|test|ทดสอบ/.test(d)) return '测试异常';
            if (/包装|pack|แพ็ค/.test(d)) return '包装异常';
            return '其他';
        }
        function safeNum(val) { const n = Number(val); return isNaN(n) ? 0 : n; }
        function safeFormat(val) { return parseFloat(Number(val).toFixed(2)); }
        function calcWsData(date, ws) {
            let currentDateStr = window.safeDOM.val("globalDate");
            if (!date || date === "undefined") date = currentDateStr || new Date().toISOString().split('T')[0];
            try {
                let wData = db.prod[date][ws]; if (!wData) return { target:0, output:0, hours:0, loss:0, upph:0, att:0, head:0 };
                let t = safeNum(wData.t); let o = safeNum(wData.o); let missing = o < t ? (o - t) : 0;
                let h = safeNum(wData.h); let upph = h > 0 ? (o/h) : 0;
                return { target: t, output: o, hours: h, loss: Math.floor(missing), upph: safeFormat(upph), att: safeNum(wData.att), head: safeNum(wData.head) };
            } catch(e) { return { target:0, output:0, hours:0, loss:0, upph:0, att:0, head:0 }; }
        }
        function showToast(icon, msg, type='success') { let t = document.getElementById('toast'); document.getElementById('toast-msg').innerText = msg; t.querySelector('i').className = icon; t.style.background = type==='error' ? 'var(--danger)' : 'var(--gradient-brand)'; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2500); }
        // ★ 方案5:快捷日期设置(今天/昨天/本月)
        window.setQuickDateRange = function(startId, endId, preset) {
            try {
                var today = new Date();
                function _pad(n) { return n < 10 ? '0' + n : String(n); }
                function _fmt(d) { return d.getFullYear() + '-' + _pad(d.getMonth()+1) + '-' + _pad(d.getDate()); }
                var sVal, eVal = _fmt(today);
                if (preset === 'today') { sVal = eVal; }
                else if (preset === 'yesterday') {
                    var y = new Date(today); y.setDate(y.getDate()-1); sVal = eVal = _fmt(y);
                } else if (preset === 'month') {
                    sVal = today.getFullYear() + '-' + _pad(today.getMonth()+1) + '-01';
                }
                var sEl = document.getElementById(startId);
                var eEl = document.getElementById(endId);
                if (sEl) { sEl.value = sVal; if (sEl.onchange) sEl.onchange(); }
                if (eEl) { eEl.value = eVal; if (eEl.onchange) eEl.onchange(); }
            } catch(e) {}
        };
        function initParticles() {
            if (typeof particlesJS !== 'function' || !document.getElementById('particles-js')) return;
            try {
                particlesJS('particles-js', {
                    particles: {
                        number: { value: 28, density: { enable: true, value_area: 900 } },
                        color: { value: '#38bdf8' },
                        shape: { type: 'circle' },
                        opacity: { value: 0.18, random: true },
                        size: { value: 3, random: true },
                        line_linked: { enable: true, distance: 150, color: '#38bdf8', opacity: 0.12, width: 1 },
                        move: { enable: true, speed: 0.8, direction: 'none', random: false, straight: false, out_mode: 'out' }
                    },
                    interactivity: {
                        detect_on: 'canvas',
                        events: { onhover: { enable: false }, onclick: { enable: false }, resize: true }
                    },
                    retina_detect: true
                });
            } catch(e) {
                console.warn('Particles disabled:', e);
            }
        }
        function updateCloudStatus() {
            const badge = window.safeDOM ? window.safeDOM.get("cloud-status-badge") : document.getElementById("cloud-status-badge");
            if (!badge) return;
            if (isFirebaseReady) {
                badge.innerHTML = `<i class="fa-solid fa-cloud"></i> <span data-i18n="status_online">${t('status_online')}</span>`;
                badge.style.color = 'var(--midea-blue)';
            } else {
                badge.innerHTML = `<i class="fa-solid fa-hard-drive"></i> <span data-i18n="status_offline">${t('status_offline')}</span>`;
                badge.style.color = 'var(--text-muted)';
            }
        }
        window.forceSyncCloud = async function() {
            showToast('fa-solid fa-spinner fa-spin', '同步云端...');
            try {
                if (isFirebaseReady) await saveToFirebase();
                showToast('fa-solid fa-check', '同步成功');
            } catch(e) {
                showToast('fa-solid fa-xmark', '同步失败', 'error');
            }
        };
        const getEmptyDay = () => {
            let conf = db.dLinesConfig || { PRO1:[], PRO3:[], PRO4:[] };
            let day = { 'PRO2': { t: 0, o: 0, h: 0, att: 0, head: 0, lines: { 'LINE A':{t:0,o:0,h:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}}, 'LINE B':{t:0,o:0,h:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}}, 'LINE C':{t:0,o:0,h:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}}, 'LINE D':{t:0,o:0,h:0,shifts:{D:{t:0,o:0}}} } } };
            ['PRO1', 'PRO3', 'PRO4'].forEach(ws => { day[ws] = { t: 0, o: 0, h: 0, att: 0, head: 0, shifts: { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } }, dLines: [] }; if (conf[ws]) conf[ws].forEach(l => { day[ws].dLines.push({ id: l.id, name: l.name, t:0, o:0, h:0, att:0, head:0 }); }); });
            // 新增电机线指标(带班次)
            ['H_MOTOR', 'F_MOTOR', 'S_MOTOR', 'CRANK'].forEach(ws => { day[ws] = { t: 0, o: 0, h: 0, att: 0, head: 0, shifts: { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } } }; });
            return day;
        };

        // 长期默认目标数据
        const getEmptyDefaultTargets = () => ({
            'PRO1': { t: 2000, h: 85, att: 121, head: 129 },
            'PRO2': { t: 23400, h: 10000, att: 545, head: 556,
                lines: {
                    'LINE A': { t: 6000, h: 2500 },
                    'LINE B': { t: 6000, h: 2500 },
                    'LINE C': { t: 6000, h: 2500 },
                    'LINE D': { t: 5400, h: 2500 }
                }
            },
            'PRO3': { t: 5000, h: 300, att: 45, head: 48 },
            'PRO4': { t: 3000, h: 200, att: 32, head: 34 },
            'H_MOTOR': { t: 800, h: 60, att: 18, head: 20 },
            'F_MOTOR': { t: 600, h: 50, att: 15, head: 16 },
            'S_MOTOR': { t: 400, h: 40, att: 12, head: 13 },
            'CRANK': { t: 500, h: 45, att: 14, head: 15 }
        });
        const getEmptyDM = () => ({ 'PRO1':{am:0,pm:0}, 'PRO2':{am:0,pm:0}, 'PRO3':{am:0,pm:0}, 'PRO4':{am:0,pm:0}, 'H_MOTOR':{am:0,pm:0}, 'F_MOTOR':{am:0,pm:0}, 'S_MOTOR':{am:0,pm:0}, 'CRANK':{am:0,pm:0} });
        function repairData() {
            if(!db.dLinesConfig) db.dLinesConfig = { PRO1:[], PRO3:[], PRO4:[] };
            if(!db.loss) db.loss = [];
            if(!db.sysOps) db.sysOps = {};
            if(!db.sysDetail) db.sysDetail = { pre: [], mid: [], equipment: [] };
            if(!db.sysDetail.pre) db.sysDetail.pre = [];
            if(!db.sysDetail.mid) db.sysDetail.mid = [];
            if(!db.sysDetail.equipment) db.sysDetail.equipment = [];
            if(!db.improveProjects) db.improveProjects = [];
            if(!db.kaizen) db.kaizen = [];
            if(!db.problems) db.problems = [];
            if(!db.defaultTargets) db.defaultTargets = getEmptyDefaultTargets();
            if(!db.targetSettings) db.targetSettings = { workshops: {}, otherLines: {} };

            // 确保每个车间都有dLinesConfig
            ['PRO1', 'PRO3', 'PRO4'].forEach(ws => {
                if(!db.dLinesConfig[ws]) db.dLinesConfig[ws] = [];
                if(!Array.isArray(db.dLinesConfig[ws])) db.dLinesConfig[ws] = [];
            });
            for(let d in db.prod) {
                if (!d || d === "undefined") continue;
                if (!db.prod[d]) { delete db.prod[d]; continue; }
                ['PRO1', 'PRO3', 'PRO4'].forEach(ws => {
                    if(!db.prod[d][ws]) db.prod[d][ws] = {t:0,o:0,h:0,att:0,head:0,dLines:[]};
                    if(!db.prod[d][ws].dLines) db.prod[d][ws].dLines = [];
                    if(db.dLinesConfig && db.dLinesConfig[ws] && Array.isArray(db.dLinesConfig[ws])) {
                        db.dLinesConfig[ws].forEach(gLine => { if(!db.prod[d][ws].dLines.find(l => l.id === gLine.id)) db.prod[d][ws].dLines.push({ id: gLine.id, name: gLine.name, t:0, o:0, h:0, att:0, head:0 }); });
                    }
                });
                if (!db.prod[d]['PRO2']) db.prod[d]['PRO2'] = {t:0,o:0,h:0,att:0,head:0,lines:{}};
                if (!db.prod[d]['PRO2'].lines || Object.keys(db.prod[d]['PRO2'].lines).length === 0) {
                    db.prod[d]['PRO2'].lines = {
                        'LINE A':{t:0,o:0,h:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}},
                        'LINE B':{t:0,o:0,h:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}},
                        'LINE C':{t:0,o:0,h:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}},
                        'LINE D':{t:0,o:0,h:0,shifts:{D:{t:0,o:0}}}
                    };
                }
                // 确保每条线有正确的班次结构
                ['LINE A','LINE B','LINE C','LINE D'].forEach(function(ln) {
                    if(db.prod[d]['PRO2'].lines[ln]) {
                        if(!db.prod[d]['PRO2'].lines[ln].shifts) db.prod[d]['PRO2'].lines[ln].shifts = {};
                        if(!db.prod[d]['PRO2'].lines[ln].shifts.D) db.prod[d]['PRO2'].lines[ln].shifts.D = {t:0,o:0};
                        if(ln === 'LINE D') {
                            delete db.prod[d]['PRO2'].lines[ln].shifts.N;
                        } else {
                            if(!db.prod[d]['PRO2'].lines[ln].shifts.N) db.prod[d]['PRO2'].lines[ln].shifts.N = {t:0,o:0};
                        }
                    }
                });
                // 确保新电机线指标存在(带班次)
                ['H_MOTOR', 'F_MOTOR', 'S_MOTOR', 'CRANK'].forEach(function(ws) {
                    if(!db.prod[d][ws]) db.prod[d][ws] = {t:0,o:0,h:0,att:0,head:0,shifts:{D:{t:0,o:0},N:{t:0,o:0}}};
                    if(!db.prod[d][ws].shifts) db.prod[d][ws].shifts = {D:{t:0,o:0},N:{t:0,o:0}};
                });
                // 确保 PRO1, PRO3, PRO4 有班次结构
                ['PRO1', 'PRO3', 'PRO4'].forEach(function(ws) {
                    if(db.prod[d][ws] && !db.prod[d][ws].shifts) db.prod[d][ws].shifts = {D:{t:0,o:0},N:{t:0,o:0}};
                });
            }
        }
        async function initApp() {
            // ★ 一次性清理旧版时间戳备份(2026-05-22 后不再产生)
            try { for (var _ci_ = localStorage.length - 1; _ci_ >= 0; _ci_--) { var _ck_ = localStorage.key(_ci_); if (_ck_ && _ck_.startsWith(DB_KEY + '_backup_') && _ck_ !== DB_KEY + '_backup') { localStorage.removeItem(_ck_); } } } catch(ex_1) {}
            initParticles(); const today = new Date(); const localDate = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
            setTheme(localStorage.getItem('mbs_ui_theme') || '');
            setDensity(localStorage.getItem('mbs_ui_density') || 'compact');
            let dateInput = document.getElementById('globalDate'); if (dateInput) dateInput.value = localDate;
            let past7Date = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)); past7Date.setDate(past7Date.getDate() - 6); let past7DateStr = past7Date.toISOString().split('T')[0];
            document.getElementById('psp-ai-start').value = past7DateStr; document.getElementById('psp-ai-end').value = localDate;
            document.getElementById('loss-ai-start').value = past7DateStr; document.getElementById('loss-ai-end').value = localDate;
            const deptFilter1 = document.getElementById('f-dept'); const deptFilter2 = document.getElementById('fl-dept');
            DEPTS.forEach(d => { let opt1 = document.createElement('option'); opt1.value = d; opt1.innerText = d; deptFilter1.appendChild(opt1); let opt2 = document.createElement('option'); opt2.value = d; opt2.innerText = d; deptFilter2.appendChild(opt2); });

            // 先从 localStorage 加载
            let saved = localStorage.getItem(DB_KEY);
            if(saved) {
                try { db = JSON.parse(saved); } catch(e) { console.error('localStorage 解析失败:', e); }
            }
            // ★ 重要:window.db 同步为最新的 db 引用(因为 db 被 JSON.parse 重赋值了)
            window.db = db;
            // ★ 清理本地已加载数据中的不合法 key(可能来自之前版本遗留)
            sanitizeForFirebase(db, 'initLoad');
            // ★ 立即保存清理后的数据到 localStorage,防止下次加载仍读旧数据
            try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(le) {
                try { localStorage.removeItem(DB_KEY + '_backup'); } catch(ex) {}
                try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e2) {}
            }
            if(!db.prod) injectSafeDemo();

            // 尝试从 Firebase 加载(如果已就绪)
            if (isFirebaseReady) {
                try {
                    const cloudData = await loadFromFirebase();
                    if (cloudData && cloudData.db) {
                        var cloudCounter = cloudData.writeCounter || 0;
                        console.log('[Firebase] 初始加载对比: 本地计数器=' + _localWriteCounter + ', 云端计数器=' + cloudCounter);

                        // ★ 关键修复:只有云端计数器大于本地计数器时才合并
                        //   如果本地计数器 >= 云端计数器,说明本地数据与云端至少一样新
                        //   直接合并会覆盖本地的删除操作(云端旧数据中的已删条目会恢复)
                        if (cloudCounter > _localWriteCounter) {
                            console.log('[Firebase] 云端数据更新,执行合并');
                            mergeCloudData(cloudData.db);
                            // 更新本地计数器为云端值
                            _localWriteCounter = cloudCounter;
                            localStorage.setItem('_firebaseWriteSeq', String(_localWriteCounter));
                        } else {
                            console.log('[Firebase] 本地数据 >= 云端 (local=' + _localWriteCounter + ', cloud=' + cloudCounter + '),跳过合并,推送本地数据到云端');
                            // 本地有更新(如删除操作),推送到云端覆盖旧数据
                            // 使用 forceSave 以确保推送成功
                            setTimeout(function() {
                                window.forceSaveToFirebase();
                            }, 100);
                        }
                    }
                } catch(e) {
                    console.error('[Firebase] 加载失败:', e);
                }
            }
            // ★ 再次确保 window.db 与 db 同步(Firebase merge 后可能产生新引用)
            window.db = db;
            repairData(); ensureProdData(localDate); ensureDMData(localDate); ensureSysData(localDate); document.getElementById('memoText').value = translateUserText(db.memo);
            // 同步目标月份到看板内嵌面板
            var mtm = document.getElementById('monitorTargetMonth');
            if(mtm) {
                var tm = document.getElementById('targetMonth');
                if(tm && tm.value) mtm.value = tm.value;
                else mtm.value = localDate.slice(0,7);
            }
            isAppReady = true; changeLanguage('zh');
            // 确保实况数据录入页面表格正确渲染
            setTimeout(function() {
                try {
                    // 强制重新修复数据
                    repairData();
                    renderInput();
                    console.log('实况数据录入表格手动渲染完成');
                } catch(e) {
                    console.error('手动渲染表格失败:', e);
                }
            }, 100);
            // ★ 方案3:URL Hash导航——从hash恢复上次查看的页面
            try {
                var hashPage = (window.location.hash || '').replace('#', '');
                if (hashPage && hashPage !== 'p-input' && document.getElementById(hashPage)) {
                    setTimeout(function() {
                        try { showPage(hashPage); } catch(e) {}
                    }, 350);
                }
            } catch(e) {}
        }
        function injectSafeDemo() {
            // 只初始化缺失的数据结构,不覆盖已有数据
            if(!db.prod) db.prod = {};
            if(!db.dm) db.dm = {};
            if(!db.loss) db.loss = [];
            if(!db.problems) db.problems = [];
            if(db.memo === undefined) db.memo = '';
            if(!db.dLinesConfig) db.dLinesConfig = { PRO1:[], PRO3:[], PRO4:[] };
            if(!db.sysOps) db.sysOps = {};
            if(!db.sysDetail) db.sysDetail = { pre: [], mid: [] };
            if(!db.sysDetail.pre) db.sysDetail.pre = [];
            if(!db.sysDetail.mid) db.sysDetail.mid = [];
            if(!db.kaizen) db.kaizen = [];

            // 只有当没有任何生产数据时才添加演示数据
            if(Object.keys(db.prod).length === 0) {
                let today = new Date(); let start = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)); start.setDate(start.getDate() - 10);
                for(let i=0; i<=15; i++) {
                    let d = new Date(start); d.setDate(d.getDate() + i); let dateStr = d.toISOString().split('T')[0]; db.prod[dateStr] = getEmptyDay();
                    db.prod[dateStr]['PRO1'].t = 2000; db.prod[dateStr]['PRO1'].o = 1950 + Math.floor(Math.random()*200); db.prod[dateStr]['PRO1'].h = 85; db.prod[dateStr]['PRO1'].att = 121; db.prod[dateStr]['PRO1'].head = 129;
                    db.prod[dateStr]['PRO2'].t = 23400; db.prod[dateStr]['PRO2'].o = 21000 + Math.floor(Math.random()*2000); db.prod[dateStr]['PRO2'].h = 10000; db.prod[dateStr]['PRO2'].att = 545; db.prod[dateStr]['PRO2'].head = 556;
                    db.dm[dateStr] = { 'PRO1':{am:1,pm:1}, 'PRO2':{am:1,pm:1}, 'PRO3':{am:1,pm:1}, 'PRO4':{am:1,pm:Math.random()>0.5?1:0} };
                    db.sysOps[dateStr] = {m4:100, insp:100, andon:5, memo:'安全生产', locked:false};
                }
            }
            let dStr = window.safeDOM.val("globalDate") || new Date().toISOString().split('T')[0];

            // 只在没有问题时添加演示问题
            if(db.problems.length === 0) {
                db.problems = [ { id:1, date:dStr, ws:'PRO2', desc:'C轴短缺导致线体停机', loc:'LINE A', owner:'王工', dept:'PC', status:'未解决' } ];
            }

            // 保留用户已有的sysDetail数据,只添加演示数据如果为空
            if(db.sysDetail.pre.length === 0) {
                db.sysDetail.pre = [
                    { id: 101, date: dStr, ws:'PRO2', ownerDept:'PE', line:'LINE A', item:'关键设备按时点检', equipment:'气密测试机', issue:'无异常', resp:'设备班', status:'已完成' }
                ];
            }
            if(db.sysDetail.mid.length === 0) {
                db.sysDetail.mid = [
                    { id: 201, date: dStr, ws:'PRO2', line:'LINE A', event:'Andon响应', responseMin:5, waitMin:0, impactQty:0, patrol:'巡检正常', action:'保持节拍确认', resp:'班长', status:'已关闭' }
                ];
            }

            // 只在没有改善项目时添加演示数据
            if(db.kaizen.length === 0) {
                db.kaizen = [
                    { id: 301, project:'焊接工装自动化改造 - LINE B', ws:'PRO2', saved:3, completeDate:'', status:'进行中', owner:'设备科' },
                    { id: 302, project:'来料检验流程合并', ws:'QA', saved:1, completeDate:'', status:'进行中', owner:'品质部' },
                    { id: 303, project:'包装段机器人替代', ws:'PRO4', saved:2, completeDate:'', status:'未开始', owner:'精益办' },
                    { id: 304, project:'组装线 LINE A 工位合并', ws:'PRO2', saved:4, completeDate:'2026-04-25', status:'已完成', owner:'生产部' }
                ];
            }
            db.kaizen = db.kaizen.map(function(r){ if(!r.owner) r.owner=''; if(!r.status) r.status='未开始'; if(!r.completeDate) r.completeDate=''; return r; });

            if(!db.prodReport) db.prodReport = {};
            if(!db.prodReport[dStr]) {
                db.prodReport[dStr] = {
                    upph: { pic: 'Mr.PAN', baseline: 1.29, dailyOutput: 24675, dailyHr: 9845, dailyUPPH: 2.51, dailyRate: 94.30, monthOutput: 446306, monthHr: 225751, monthUPPH: 1.98, monthRate: 53.25 },
                    shifts: [
                        { line: 'A', shift: 'D', target: 3500, actual: 4041, rate: 115.46, rank: 1, mTarget: 154000, mActual: 138312, mRate: 89.81, mRank: 3 },
                        { line: 'A', shift: 'N', target: 3500, actual: 3800, rate: 108.57, rank: 3, mTarget: 0, mActual: 0, mRate: 0, mRank: 7 },
                        { line: 'B', shift: 'D', target: 4200, actual: 3891, rate: 92.64, rank: 6, mTarget: 179400, mActual: 161136, mRate: 89.82, mRank: 2 },
                        { line: 'B', shift: 'N', target: 4200, actual: 4002, rate: 95.29, rank: 5, mTarget: 0, mActual: 0, mRate: 0, mRank: 7 },
                        { line: 'C', shift: 'D', target: 3500, actual: 3876, rate: 110.74, rank: 2, mTarget: 133000, mActual: 129876, mRate: 97.65, mRank: 1 },
                        { line: 'C', shift: 'N', target: 3500, actual: 3354, rate: 95.83, rank: 4, mTarget: 0, mActual: 0, mRate: 0, mRank: 7 },
                        { line: 'D', shift: 'D', target: 2800, actual: 2626, rate: 93.79, rank: 7, mTarget: 56200, mActual: 16982, mRate: 30.22, mRank: 4 }
                    ],
                    notes: 'A、人员影响:LINE A D班缺勤2人,产出受影响约200pcs\nB、设备影响:气密测试机LINE C午间故障30min,影响约150pcs\nC、品质影响:LINE B发生品质异常停线20min\nD、物料影响:C轴物料到货延迟,LINE A N班等待15min'
                };
            }
            db.memo = db.memo || "运营复盘:PRO4需检讨异常。";
        }
        // ★ 页面关闭前强制保存到本地和云端
        window.addEventListener('beforeunload', function(){
            try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
            // Firebase 同步保存(使用 Navigator.sendBeacon 确保关闭前完成)
            if (isFirebaseReady) {
                try {
                    const data = JSON.stringify({ db: db, clientId: CLIENT_ID, updatedAt: Date.now() });
                    // Firebase REST API 方式(使用 sendBeacon 确保发送)
                    const url = 'https://dm111-e8a7d-default-rtdb.firebaseio.com/dm_system.json?auth=AIzaSyBrl-gHO48HnyM4e8nkl2vqR7mz4f5mv_E';
                    navigator.sendBeacon(url, data);
                } catch(e) { console.error('beforeunload sync failed:', e); }
            }
        });
        // ★ 强制保存按钮功能
        window.forceSaveAll = async function() {
            try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
            if (isFirebaseReady) {
                const success = await saveToFirebase();
                if (success) {
                    showToast('fa-solid fa-check', '已保存到云端 ✓');
                    return;
                }
            }
            showToast('fa-solid fa-check', '已保存到本地 ✓');
        };
        // ================= 其他页面的通用方向键导航(不干扰 inputTbody 内的网格导航) =================
        document.addEventListener('keydown', function(e) {
            var el = e.target;
            if(!el || el.tagName !== 'INPUT') return;
            // inputTbody 内的输入框由网格导航处理
            if (el.closest('#inputTbody')) return;
            var t = (el.type || '').toLowerCase();
            if(t !== 'number' && t !== 'text' && t !== 'tel') return;
            if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            // 只收集当前可见页面内的输入框,按DOM顺序排列
            var all = Array.from(document.querySelectorAll('.page.active input[type=number], .page.active input[type=text], .page.active input[type=tel]'))
                .filter(function(x){ return x.offsetParent !== null; });
            var idx = all.indexOf(el);
            if(idx === -1) return;
            if(e.key === 'ArrowLeft' && idx > 0) { all[idx-1].focus(); return; }
            if(e.key === 'ArrowRight' && idx+1 < all.length) { all[idx+1].focus(); return; }
            if(e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                // 基于元素位置寻找最邻近的输入框(Excel风格)
                var rect = el.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                var bestIdx = -1;
                var bestScore = Infinity;
                var dir = e.key === 'ArrowUp' ? -1 : 1;
                all.forEach(function(inp, i) {
                    if(i === idx) return;
                    var r = inp.getBoundingClientRect();
                    var icx = r.left + r.width / 2;
                    var icy = r.top + r.height / 2;
                    var yDist = dir > 0 ? (icy - cy) : (cy - icy);
                    if(yDist <= 0) return; // 只找上方(Up)或下方(Down)的元素
                    var xDist = Math.abs(icx - cx);
                    var score = xDist + yDist * 0.3; // 垂直距离权重高
                    if(score < bestScore) { bestScore = score; bestIdx = i; }
                });
                if(bestIdx >= 0) all[bestIdx].focus();
            }
        });
        function ensureProdData(date) { if(!db.prod[date]){db.prod[date]=getEmptyDay(); triggerAutoSave();} return db.prod[date]; }
        function ensureDMData(date) { if(!db.dm[date]){db.dm[date]=getEmptyDM(); triggerAutoSave();} return db.dm[date]; }
        let uiState = { expanded: { 'PRO2': true, 'PRO1': false, 'PRO3': false, 'PRO4': false } };
        window.toggleSidebar = function() { document.getElementById('sidebar').classList.toggle('collapsed'); };
        window.showPage = function(id, btn) {
            // ★ 方案1:切换页面时自动保存当前数据,防止编辑丢失
            if (typeof triggerAutoSave === 'function') triggerAutoSave();
            document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
            document.querySelectorAll('.nav-link').forEach(function(l){ l.classList.remove('active'); });
            // ★ 切换页面时自动关闭系统详情面板和图片模态框，防止模块内容污染
            var _panel = document.getElementById('sys-detail-panel');
            if (_panel) _panel.style.display = 'none';
            var _photoModal = document.getElementById('equip-photo-modal');
            if (_photoModal) {
                _photoModal.style.display = 'none';
                // 清理粘贴监听器
                if (window._equipModalPasteHandler) {
                    document.removeEventListener('paste', window._equipModalPasteHandler);
                    delete window._equipModalPasteHandler;
                }
                window._equipModalDataUrl = null;
                window._equipModalCompressed = null;
                window.currentEquipmentPhotoIndex = null;
            }
            // 使用 requestAnimationFrame 确保 DOM 刷新后执行动画
            requestAnimationFrame(function() {
                const targetPage = document.getElementById(id);
                targetPage.classList.add('active');
                if(btn) btn.classList.add('active');
                refreshAllViews();

                // 特殊处理报告页面,确保图表正确渲染
                if (id === 'p-report') {
                    console.log('切换到报告页面,准备渲染图表...');
                    setTimeout(function() {
                        if (typeof window.renderReport === 'function') {
                            window.renderReport();
                        }
                    }, 100);
                }
            });
            // 4M预警检测
            var badge = document.getElementById('sys-nav-badge');
            if(badge) {
                var preItems = (db.sysDetail||{}).pre || [];
                var unconfirmed = preItems.filter(function(r){ return r.status !== '已完成'; }).length;
                if(unconfirmed > 0) { badge.style.display = 'inline'; badge.innerText = unconfirmed; }
                else { badge.style.display = 'none'; }
            }
            // 切换到看板时同步目标月份
            if(id === 'p-monitor') {
                var mm = document.getElementById('monitorTargetMonth');
                var tm = document.getElementById('targetMonth');
                if(mm && tm && tm.value && !mm.value) mm.value = tm.value;
            }
            // ★ 方案3:URL Hash记住当前页面,刷新后自动恢复
            try { window.location.hash = id; } catch(e) {}
        };
        window.handleDateChange = function() { let date = window.safeDOM.val("globalDate"); ensureProdData(date); ensureDMData(date); ensureSysData(date); document.getElementById('memoText').value = translateUserText(db.memo || ''); refreshAllViews(); };
        window.saveMemo = function() { db.memo = document.getElementById('memoText').value; triggerAutoSave(); };
        // 回退全量渲染(按页面渲染的优化在下一次重构时再引入,当前以稳定优先)
        // ★ 性能优化:保存并恢复滚动位置,防止 re-render 后页面跳顶
        function _saveScrollPos() {
            // 仅记录滚动容器
            var activePage = document.querySelector('.page.active');
            if (activePage) {
                activePage._savedScrollTop = activePage.scrollTop;
            }
        }
        function _restoreScrollPos() {
            var activePage = document.querySelector('.page.active');
            if (activePage && activePage._savedScrollTop != null) {
                activePage.scrollTop = activePage._savedScrollTop;
            }
        }
        // ★ 防抖刷新视图(100ms防抖),防止批量修改触发数十次全量渲染
        var _refreshDebounceTimer = null;
        function refreshAllViews() {
            _saveScrollPos();
            if (_refreshDebounceTimer) {
                clearTimeout(_refreshDebounceTimer);
            }
            _refreshDebounceTimer = setTimeout(function() {
                _refreshDebounceTimer = null;
                try { document.getElementById('dash-dynamic-title').innerText = `${window.safeDOM.val("globalDate")} ${t('dash_title')}`; } catch(e) {}
                var pRd = document.getElementById('prodReportDate');
                if(pRd && !window._prodReportDateSet) { pRd.value = window.safeDOM.val("globalDate"); window.prodReportDate = pRd.value; }
                // ★ 核心优化:仅渲染当前可见页面,不渲染全部页面
                var activePage = document.querySelector('.page.active');
                var activeId = activePage ? activePage.id : '';

                // 按页面ID映射渲染函数
                var pageRenderMap = {
                    'p-input': [renderInput],
                    'p-sys': [renderSysOps],
                    'p-monitor': [renderMonitor],
                    'p-improve-track': [renderImproveProjects, populateImproveDeptFilter],
                    'p-dm': [renderDM, renderPDCA],
                    'p-loss': [renderLoss],
                    'p-trend': [renderTrend, renderReport],
                    'p-report': [renderReport],
                };

                // 永远渲染的全局页面(看板、趋势等跨页面数据显示)
                var alwaysRender = [];
                // 小数据量的全局函数(UPPH看板、报告)可保留
                if (activeId !== 'p-input' && activeId !== 'p-dm' && activeId !== 'p-loss') {
                    // 非编辑页面也保持部分数据最新
                }

                // 只渲染当前可见页面的对应函数
                var tasksToRun = (pageRenderMap[activeId] || alwaysRender).filter(Boolean);
                // ★ 焦点保护:如果用户正在编辑输入框,跳过会销毁该表格的重绘,等 blur 后再更新
                var _activeEl = document.activeElement;
                var _isEditing = _activeEl && ['INPUT','TEXTAREA','SELECT'].includes(_activeEl.tagName);
                if (_isEditing) {
                    tasksToRun = tasksToRun.filter(function(fn) {
                        var n = fn.name || '';
                        // renderLoss/renderPDCA/renderDM/renderInput 会销毁重建 DOM 导致失焦
                        if (['renderLoss','renderPDCA','renderDM','renderInput'].includes(n)) {
                            // 延迟到用户离开输入框后再渲染
                            if (!window._deferredCloudRender) {
                                window._deferredCloudRender = [];
                            }
                            window._deferredCloudRender.push(fn);
                            if (!window._deferredBlurHandler) {
                                window._deferredBlurHandler = function() {
                                    setTimeout(function() {
                                        if (window._deferredCloudRender) {
                                            window._deferredCloudRender.forEach(function(dfn) {
                                                try { dfn(); } catch(e) {}
                                            });
                                            window._deferredCloudRender = null;
                                        }
                                        window._deferredBlurHandler = null;
                                    }, 200);
                                };
                                document.addEventListener('blur', window._deferredBlurHandler, { once: true });
                            }
                            return false;
                        }
                        return true;
                    });
                }
                // ★ 额外确保:所有页面共用的后台渲染(很小的开销)
                [renderProdReport, renderDM, renderKaizen, renderTrend, renderReport,
                 function(){try{renderSimConfig()}catch(e){}},
                 function(){try{renderSimAttendance()}catch(e){}}].forEach(function(task) {
                    try { task(); } catch(e) {}
                });

                // 按顺序执行页面特定渲染
                tasksToRun.forEach(function(task) {
                    try { task(); } catch(e) {}
                });


                _restoreScrollPos();
            }, 100); // 100ms 防抖
        }
        window.updateCell = function(ws, field, val) {
            let dateStr = window.safeDOM.val("globalDate");
            db.prod[dateStr][ws][field] = safeNum(val);
            triggerAutoSave();
            syncInputToProdReport(dateStr);
            refreshUPPHCells(dateStr);
        };
        // 新增:电机线班次数据更新函数
        window.updateMotorShift = function(ws, shift, field, val) {
            var dateStr = window.safeDOM.val("globalDate");
            if(!db.prod[dateStr]) db.prod[dateStr] = getEmptyDay();
            if(!db.prod[dateStr][ws]) db.prod[dateStr][ws] = { t: 0, o: 0, h: 0, att: 0, head: 0, shifts: { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } } };
            if(!db.prod[dateStr][ws].shifts) db.prod[dateStr][ws].shifts = { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } };
            if(!db.prod[dateStr][ws].shifts[shift]) db.prod[dateStr][ws].shifts[shift] = { t: 0, o: 0 };
            db.prod[dateStr][ws].shifts[shift][field] = safeNum(val);
            // 自动汇总班次数据到主行
            var dT = safeNum(db.prod[dateStr][ws].shifts.D?.t) || 0;
            var dO = safeNum(db.prod[dateStr][ws].shifts.D?.o) || 0;
            var nT = safeNum(db.prod[dateStr][ws].shifts.N?.t) || 0;
            var nO = safeNum(db.prod[dateStr][ws].shifts.N?.o) || 0;
            db.prod[dateStr][ws].t = dT + nT;
            db.prod[dateStr][ws].o = dO + nO;
            triggerAutoSave();
            refreshUPPHCells(dateStr);
        };

        // 独立产线整线产出直接编辑(优先使用总产出,不自动分配班次)
        window.updateMotorTotal = function(ws, field, val) {
            var dateStr = window.safeDOM.val("globalDate");
            if(!db.prod[dateStr]) db.prod[dateStr] = getEmptyDay();
            if(!db.prod[dateStr][ws]) db.prod[dateStr][ws] = { t: 0, o: 0, h: 0, att: 0, head: 0, shifts: { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } } };

            // 直接更新总产出,班次数据保持不变
            db.prod[dateStr][ws][field] = safeNum(val);

            triggerAutoSave();
            // 同步到报表
            if (typeof syncInputToProdReport === 'function') {
                syncInputToProdReport(dateStr);
            }
            refreshUPPHCells(dateStr);
        };

        // 从默认目标填充当前日期的目标值
        window.fillFromDefaultTargets = function() {
            var dateStr = window.safeDOM.val("globalDate");
            if(!confirm('确定要从长期默认目标填充当前日期的目标值吗?实际产出数据将保持不变。')) return;

            ensureProdData(dateStr);

            // 填充各车间目标值
            Object.keys(db.defaultTargets).forEach(function(ws) {
                var defaults = db.defaultTargets[ws];
                if (defaults) {
                    // 填充主车间目标
                    if (db.prod[dateStr][ws]) {
                        if (defaults.t !== undefined) db.prod[dateStr][ws].t = defaults.t;
                        if (defaults.h !== undefined) db.prod[dateStr][ws].h = defaults.h;
                        if (defaults.att !== undefined) db.prod[dateStr][ws].att = defaults.att;
                        if (defaults.head !== undefined) db.prod[dateStr][ws].head = defaults.head;
                    }

                    // 填充PRO2各线体目标
                    if (ws === 'PRO2' && defaults.lines) {
                        Object.keys(defaults.lines).forEach(function(lineName) {
                            if (db.prod[dateStr].PRO2.lines[lineName]) {
                                var lineDefaults = defaults.lines[lineName];
                                if (lineDefaults.t !== undefined) db.prod[dateStr].PRO2.lines[lineName].t = lineDefaults.t;
                                if (lineDefaults.h !== undefined) db.prod[dateStr].PRO2.lines[lineName].h = lineDefaults.h;
                            }
                        });
                    }
                }
            });

            triggerAutoSave();
            syncInputToProdReport(dateStr);
            renderInput();
            showToast('fa-solid fa-check', '已从默认目标填充当前日期的目标值');
        };

        // 简洁实用的目标设定功能
        window.showTargetSetting = function() {
            // 获取当前月份
            let currentDate = new Date(window.safeDOM.val("globalDate") || new Date().toISOString().split('T')[0]);
            let currentMonth = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0');

            // 初始化目标数据
            if (!db.targetSettings) {
                db.targetSettings = {
                    monthlyWorkDays: 22,
                    workshops: {
                        PRO1: { dailyTarget: 2000, head: 129, upphTarget: 23.5 },
                        PRO2: { dailyTarget: 23400, head: 556, upphTarget: 4.29,
                            lines: {
                                'LINE A': { dailyTarget: 6000 },
                                'LINE B': { dailyTarget: 6000 },
                                'LINE C': { dailyTarget: 6000 },
                                'LINE D': { dailyTarget: 5400 }
                            }
                        },
                        PRO3: { dailyTarget: 5000, head: 48, upphTarget: 111.11 },
                        PRO4: { dailyTarget: 3000, head: 34, upphTarget: 93.75 }
                    },
                    otherLines: {
                        H_MOTOR: { dailyTarget: 800, head: 20 },
                        F_MOTOR: { dailyTarget: 600, head: 16 },
                        S_MOTOR: { dailyTarget: 400, head: 13 },
                        CRANK: { dailyTarget: 500, head: 15 }
                    }
                };
            }

            let ts = db.targetSettings;

            // 构建HTML - 简洁实用,不超出屏幕
            let html = `
            <div style="max-width: 800px; max-height: 80vh; overflow-y: auto; padding: 0 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h3 style="margin: 0; color: var(--midea-dark);">🎯 目标设定</h3>
                    <button onclick="this.closest('.modal-overlay').remove()" style="background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-muted);">✕</button>
                </div>

                <div style="margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid var(--border);">
                    <h4 style="margin-top: 0; margin-bottom: 10px; color: var(--midea-blue);">📅 全局设置</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div>
                            <label style="display: block; font-weight: 600; font-size: 13px; margin-bottom: 5px;">每月工作天数</label>
                            <input type="number" id="targetWorkDays" value="${ts.monthlyWorkDays}" min="1" max="31" style="width: 120px; padding: 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px;">
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 5px;">影响月度目标分解</div>
                        </div>
                        <div>
                            <label style="display: block; font-weight: 600; font-size: 13px; margin-bottom: 5px;">应用月份</label>
                            <input type="month" id="targetApplyMonth" value="${currentMonth}" style="width: 140px; padding: 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px;">
                        </div>
                    </div>
                </div>

                <div style="margin-bottom: 20px;">
                    <h4 style="color: var(--midea-blue); border-bottom: 1px solid var(--border-light); padding-bottom: 8px;">🏭 车间目标</h4>
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">
            `;

            // 4个车间
            ['PRO1', 'PRO2', 'PRO3', 'PRO4'].forEach(ws => {
                let wsData = ts.workshops[ws] || {};
                html += `
                    <div style="background: white; border: 1px solid var(--border); border-radius: 8px; padding: 15px;">
                        <div style="font-weight: 800; color: var(--midea-dark); margin-bottom: 10px; font-size: 14px;">${ws}</div>
                        <table style="width: 100%; font-size: 13px;">
                            <tr>
                                <td style="padding: 5px 0; width: 80px;">每日目标:</td>
                                <td><input type="number" value="${wsData.dailyTarget || 0}" style="width: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 4px; text-align: center;" onchange="saveTargetSetting('workshops', '${ws}', 'dailyTarget', this.value)"></td>
                            </tr>
                            <tr>
                                <td style="padding: 5px 0;">定编人数:</td>
                                <td><input type="number" value="${wsData.head || 0}" style="width: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 4px; text-align: center;" onchange="saveTargetSetting('workshops', '${ws}', 'head', this.value)"></td>
                            </tr>
                        </table>
                    </div>
                `;
            });

            html += `
                    </div>
                </div>

                <div style="margin-bottom: 20px;">
                    <h4 style="color: var(--midea-blue); border-bottom: 1px solid var(--border-light); padding-bottom: 8px;">⚡ 其他线体目标</h4>
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">
            `;

            // 其他线体
            let otherLines = {
                'H_MOTOR': 'H电机线',
                'F_MOTOR': 'F电机线',
                'S_MOTOR': 'S电机线',
                'CRANK': '曲轴线'
            };

            Object.entries(otherLines).forEach(([key, name]) => {
                let lineData = ts.otherLines[key] || {};
                html += `
                    <div style="background: white; border: 1px solid var(--border); border-radius: 8px; padding: 15px;">
                        <div style="font-weight: 800; color: var(--midea-dark); margin-bottom: 10px; font-size: 14px;">${name}</div>
                        <table style="width: 100%; font-size: 13px;">
                            <tr>
                                <td style="padding: 5px 0; width: 80px;">每日目标:</td>
                                <td><input type="number" value="${lineData.dailyTarget || 0}" style="width: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 4px; text-align: center;" onchange="saveTargetSetting('otherLines', '${key}', 'dailyTarget', this.value)"></td>
                            </tr>
                            <tr>
                                <td style="padding: 5px 0;">定编人数:</td>
                                <td><input type="number" value="${lineData.head || 0}" style="width: 90px; padding: 6px; border: 1px solid var(--border); border-radius: 4px; text-align: center;" onchange="saveTargetSetting('otherLines', '${key}', 'head', this.value)"></td>
                            </tr>
                        </table>
                    </div>
                `;
            });

            html += `
                    </div>
                </div>

                <div style="display: flex; gap: 10px; justify-content: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border-light);">
                    <button class="btn btn-primary" onclick="applyTargetsToMonth()" style="font-weight: bold; padding: 10px 20px;">
                        <i class="fa-solid fa-calendar-check"></i> 应用到整个月份
                    </button>
                    <button class="btn" onclick="this.closest('.modal-overlay').remove()" style="padding: 10px 20px; background: var(--text-muted); color: white;">
                        关闭
                    </button>
                </div>
            </div>
            `;

            showModal('目标设定', html);
        };

        window.saveTargetSetting = function(category, key, field, value) {
            if (!db.targetSettings) db.targetSettings = {};
            if (!db.targetSettings[category]) db.targetSettings[category] = {};
            if (!db.targetSettings[category][key]) db.targetSettings[category][key] = {};

            db.targetSettings[category][key][field] = Number(value) || 0;
            triggerAutoSave();
            showToast('fa-solid fa-save', '目标已保存');
        };

        window.applyTargetsToMonth = function() {
            let month = document.getElementById('targetApplyMonth').value;
            let workDays = parseInt(document.getElementById('targetWorkDays').value) || 22;

            if (!month || !confirm(`确定要将目标应用到 ${month} 的所有 ${workDays} 个工作日吗?`)) return;

            let ts = db.targetSettings;
            if (!ts) {
                showToast('fa-solid fa-exclamation-triangle', '请先设置目标值', 'error');
                return;
            }

            let startDate = new Date(month + '-01');
            let appliedDays = 0;

            for (let i = 0; i < workDays; i++) {
                let currentDate = new Date(startDate);
                currentDate.setDate(startDate.getDate() + i);

                // 跳过周末(可选)
                let dayOfWeek = currentDate.getDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) continue; // 跳过周六周日

                let dateStr = currentDate.toISOString().split('T')[0];
                ensureProdData(dateStr);

                // 应用车间目标
                Object.keys(ts.workshops || {}).forEach(ws => {
                    let wsData = ts.workshops[ws];
                    if (wsData && db.prod[dateStr][ws]) {
                        if (wsData.dailyTarget !== undefined) db.prod[dateStr][ws].t = wsData.dailyTarget;
                        if (wsData.head !== undefined) db.prod[dateStr][ws].head = wsData.head;

                        // 如果是PRO2,应用到各线体
                        if (ws === 'PRO2' && wsData.lines) {
                            Object.keys(wsData.lines).forEach(lineName => {
                                if (db.prod[dateStr].PRO2.lines[lineName] && wsData.lines[lineName].dailyTarget !== undefined) {
                                    db.prod[dateStr].PRO2.lines[lineName].t = wsData.lines[lineName].dailyTarget;
                                }
                            });
                        }
                    }
                });

                // 应用其他线体目标
                Object.keys(ts.otherLines || {}).forEach(line => {
                    let lineData = ts.otherLines[line];
                    if (lineData && db.prod[dateStr][line]) {
                        if (lineData.dailyTarget !== undefined) db.prod[dateStr][line].t = lineData.dailyTarget;
                        if (lineData.head !== undefined) db.prod[dateStr][line].head = lineData.head;
                    }
                });

                appliedDays++;
            }

            triggerAutoSave();
            syncInputToProdReport();
            renderInput();

            // 关闭模态框
            document.querySelector('.modal-overlay')?.remove();

            showToast('fa-solid fa-calendar-check', `已成功应用到 ${month} 的 ${appliedDays} 个工作日`);
        };
        // FIXED: 重写班次编辑函数,确保多线体数据互不干扰
        window.updateShiftCell = function(lineName, shift, field, val) {
            var dateStr = window.safeDOM.val("globalDate");
            // ★ 诊断:进入函数时快照
            var _snap = JSON.stringify(db);
            if(!db.prod || !db.prod[dateStr] || !db.prod[dateStr].PRO2) return;
            var _lines = db.prod[dateStr].PRO2.lines;
            if(!_lines || !_lines[lineName]) { console.error('LINE not found:', lineName); return; }
            if(!_lines[lineName].shifts) _lines[lineName].shifts = {};
            if(!_lines[lineName].shifts[shift]) _lines[lineName].shifts[shift] = { t:0, o:0 };
            var oldVal = _lines[lineName].shifts[shift][field];
            _lines[lineName].shifts[shift][field] = safeNum(val);
            // 重算当前线体合计
            var lnT = 0, lnO = 0;
            if(_lines[lineName].shifts.D) { lnT += Number(_lines[lineName].shifts.D.t||0); lnO += Number(_lines[lineName].shifts.D.o||0); }
            if(_lines[lineName].shifts.N) { lnT += Number(_lines[lineName].shifts.N.t||0); lnO += Number(_lines[lineName].shifts.N.o||0); }
            _lines[lineName].t = lnT;
            _lines[lineName].o = lnO;
            // 重算PRO2合计
            var ttlO = 0, ttlT = 0;
            var _lk = Object.keys(_lines);
            for(var _i=0;_i<_lk.length;_i++) { var _l=_lines[_lk[_i]]; if(_l && typeof _l.t==='number'){ ttlT+=_l.t; ttlO+=_l.o; } }
            db.prod[dateStr].PRO2.t = ttlT;
            db.prod[dateStr].PRO2.o = ttlO;
            // ★ 诊断:验证所有线体数据是否完整
            var _after = JSON.stringify(db);
            console.log('[updateShiftCell]', lineName, shift, field, 'old=', oldVal, 'new=', val, 'dataOk=', _after.length===_snap.length || _after.length>_snap.length);
            // ★ 终极防御:保存备份 + 立即持久化
            try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e){}
            // ★ 立即触发云端同步,确保多设备实时同步
            if (typeof window.triggerAutoSave === 'function') window.triggerAutoSave();
            refreshUPPHCells(dateStr);
            // ★ 诊断:render后再次验证
            var _post = db.prod[dateStr].PRO2.lines;
            console.log('[updateShiftCell] post-render verify', lineName, 'shift=', shift, 'field=', field, 'now=', _post[lineName]?.shifts?.[shift]?.[field]);
        };
        window.updateDLine = function(ws, id, field, val) {
            let dateStr = window.safeDOM.val("globalDate");
            if (field === 'name') {
                let cLine = db.dLinesConfig[ws].find(l => String(l.id) === String(id)); if(cLine) cLine.name = val;
                Object.keys(db.prod).forEach(d => { let line = db.prod[d][ws].dLines.find(l => String(l.id) === String(id)); if(line) line.name = val; });
            } else {
                let line = db.prod[dateStr][ws].dLines.find(l => String(l.id) === String(id)); if(line) line[field] = safeNum(val);
                db.prod[dateStr][ws][field] = db.prod[dateStr][ws].dLines.reduce((sum, l) => sum + safeNum(l[field]), 0);
            }
            triggerAutoSave();
            syncInputToProdReport(dateStr);
            renderInput();
        };
        window.addDLine = function(ws) { let newId = Date.now() + Math.random(); let newName = `新线体-${Math.floor(Math.random()*100)}`; db.dLinesConfig[ws].push({id: newId, name: newName}); Object.keys(db.prod).forEach(d => { db.prod[d][ws].dLines.push({ id: newId, name: newName, t:0, o:0, h:0, att:0, head:0 }); }); triggerAutoSave(); renderInput(); };
        window.delDLine = function(ws, id) { db.dLinesConfig[ws] = db.dLinesConfig[ws].filter(l => String(l.id) !== String(id)); Object.keys(db.prod).forEach(d => { db.prod[d][ws].dLines = db.prod[d][ws].dLines.filter(l => String(l.id) !== String(id)); }); _deferredLocalStorageSave(); setTimeout(function(){ if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else { triggerAutoSave(); } }, 0); renderInput(); };
        window.updateFixedLine = function(ws, lineName, field, val) { 
            let dateStr = window.safeDOM.val("globalDate"); 
            if(!db.prod[dateStr]?.[ws]?.lines?.[lineName]) return;
            db.prod[dateStr][ws].lines[lineName][field] = safeNum(val);
            // 使用Object.keys安全汇总
            let total = 0;
            Object.keys(db.prod[dateStr][ws].lines).forEach(function(k){ total += safeNum(db.prod[dateStr][ws].lines[k][field]); });
            db.prod[dateStr][ws][field] = total;
            triggerAutoSave();
            refreshUPPHCells(dateStr);
        };

        // ================= 原地刷新UPPH/LOSS单元格(无需全表重绘) =================
        window.refreshUPPHCells = function(dateStr) {
            if (!dateStr) dateStr = window.safeDOM.val("globalDate");
            // 更新每个车间的UPPH和Missing Qty列
            PRO_ORDER.forEach(function(ws) {
                var m = calcWsData(dateStr, ws);
                var upphInp = document.getElementById('inp_' + ws + '_upph');
                var lossInp = document.getElementById('inp_' + ws + '_loss');
                if (upphInp) {
                    var v = m.upph.toFixed(2);
                    upphInp.value = v;
                    upphInp.className = v >= 23 ? 'val-success' : 'val-danger';
                }
                if (lossInp) {
                    var lv = m.loss === 0 ? '0' : m.loss;
                    lossInp.value = lv;
                    lossInp.className = m.loss < 0 ? 'val-danger' : '';
                }
                // 达成率徽章
                var badge = document.getElementById('ach-' + ws);
                if(badge && m.target > 0) {
                    var rate = (m.output / m.target * 100).toFixed(0);
                    var color = rate >= 95 ? 'var(--success)' : (rate >= 80 ? 'var(--warning)' : 'var(--danger)');
                    var icon = rate >= 95 ? 'fa-check-circle' : (rate >= 80 ? 'fa-exclamation-circle' : 'fa-times-circle');
                    badge.innerHTML = '<span style="display:inline-flex;align-items:center;gap:2px;color:'+color+'"><i class="fa-solid '+icon+'" style="font-size:9px;"></i>'+rate+'%</span>';
                }
            });
            // 同步录入数据至看板UPPH表
            syncInputToProdReport(null, true);
        };

        function renderInput() {
            const date = window.safeDOM.val("globalDate"); const data = ensureProdData(date); const tbody = document.getElementById('inputTbody');
            let htmlStr = '';
            // 第一部分:原有车间数据(PRO1-PRO4)
            ['PRO1', 'PRO2', 'PRO3', 'PRO4'].forEach(ws => {
                let wData = data[ws];
                // 安全检查:如果wData不存在,使用默认值
                if (!wData) {
                    console.warn(`renderInput: wData for ${ws} is undefined, using default`);
                    wData = { t: 0, o: 0, h: 0, att: 0, head: 0, lines: {}, dLines: [] };
                    data[ws] = wData;
                }
                let m = calcWsData(date, ws); let isExp = uiState.expanded[ws]; let icon = isExp ? 'fa-minus-square' : 'fa-plus-square'; let parentLossColor = m.loss < 0 ? 'val-danger' : '';
                htmlStr += `<tr class="row-parent"><td style="text-align:left; padding-left:8px; vertical-align:middle; height:36px; border-bottom:none; background:#f8fafc;"><i class="fa-solid ${icon} expand-btn" onclick="uiState.expanded['${ws}']=!uiState.expanded['${ws}']; renderInput()"></i><span style="font-weight:900;margin-left:4px;">${ws}</span><span id="ach-${ws}" style="margin-left:6px;font-size:10px;font-weight:800;"></span></td><td><input type="number" id="inp_${ws}_t" value="${wData.t || 0}" onchange="updateCell('${ws}', 't', this.value)"></td><td><input type="number" id="inp_${ws}_o" value="${wData.o || 0}" onchange="updateCell('${ws}', 'o', this.value)"></td><td><input type="number" id="inp_${ws}_h" value="${wData.h || 0}" onchange="updateCell('${ws}', 'h', this.value)"></td><td><input type="number" id="inp_${ws}_att" value="${safeNum(wData.att)}" onchange="updateCell('${ws}', 'att', this.value)"></td><td><input type="number" id="inp_${ws}_head" value="${safeNum(wData.head)}" onchange="updateCell('${ws}', 'head', this.value)"></td><td><input type="text" readonly id="inp_${ws}_upph" value="${m.upph}" class="${m.upph>=23?'val-success':'val-danger'}"></td><td><input type="text" readonly id="inp_${ws}_loss" value="${m.loss===0?'0':m.loss}" class="${parentLossColor}"></td></tr>`;
                if(isExp) {
                    if (ws === 'PRO2') {
                        // 使用 Object.keys + 索引遍历,避免 for...in 原型链污染
                        var _lineKeys = Object.keys(wData.lines);
                        for(var _li=0; _li<_lineKeys.length; _li++) {
                            var _ln = _lineKeys[_li];
                            var ld = wData.lines[_ln];
                            if(!ld || typeof ld !== 'object') continue;
                            // 确保班次结构存在
                            if(!ld.shifts) ld.shifts = {};
                            if(!ld.shifts.D) ld.shifts.D = {t:0,o:0};
                            if(_ln !== 'LINE D' && !ld.shifts.N) ld.shifts.N = {t:0,o:0};
                            // 直接从班次数据计算线体合计(安全访问)
                            var _lineT = Number(ld.shifts.D?.t||0) + Number(ld.shifts.N?.t||0);
                            var _lineO = Number(ld.shifts.D?.o||0) + Number(ld.shifts.N?.o||0);
                            // 写回 lines 级供 PRO2 合计用
                            ld.t = _lineT; ld.o = _lineO;
                            var _lossL = _lineO < _lineT ? (_lineO - _lineT) : 0;
                            var _fId = _ln.replace(/\s+/g, '');
                            htmlStr += '<tr style="background:rgba(240, 249, 255, 0.4);"><td style="text-align:left; padding-left:45px; color:var(--midea-blue); font-weight:800; height:34px; border:none;">└ ' + _ln + '</td><td style="font-weight:700;font-size:13px;">' + _lineT + '</td><td style="font-weight:700;font-size:13px;">' + _lineO + '</td><td><input type="number" id="inp_f_' + _fId + '_h" value="' + (ld.h||0) + '" onchange="updateFixedLine(\'PRO2\',\'' + _ln + '\',\'h\',this.value);syncInputToProdReport()" style="width:70px;"></td><td colspan="2"><span style="color:#94a3b8; font-size:11px !important;">-</span></td><td><input type="text" readonly value="-"></td><td><input type="text" readonly value="' + (_lossL===0?t('normal'):_lossL) + '" class="' + (_lossL<0?'val-danger':'') + '"></td></tr>';
                            // 班次明细行
                            var sd = ld.shifts.D;
                            htmlStr += '<tr style="background:rgba(245, 250, 255, 0.6);"><td style="text-align:left; padding-left:65px; color:var(--midea-blue); font-size:11px; font-weight:600; height:28px; border:none;">  └ D班</td><td><input type="number" value="' + (sd.t||0) + '" onchange="updateShiftCell(\'' + _ln + '\',\'D\',\'t\',this.value);syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;"></td><td><input type="number" value="' + (sd.o||0) + '" onchange="updateShiftCell(\'' + _ln + '\',\'D\',\'o\',this.value);syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;" class="' + ((sd.o||0) >= (sd.t||0) ? '' : 'val-danger-bg') + '"></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td colspan="2"><span style="color:#94a3b8;font-size:10px;">-</span></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td><input type="text" readonly value="' + (Number(sd.o||0)-Number(sd.t||0)) + '" class="' + (Number(sd.o||0) < Number(sd.t||0) ? 'val-danger' : 'val-success') + '" style="font-size:11px;"></td></tr>';
                            if(ld.shifts.N) {
                            var sn = ld.shifts.N;
                            htmlStr += '<tr style="background:rgba(245, 250, 255, 0.6);"><td style="text-align:left; padding-left:65px; color:var(--midea-blue); font-size:11px; font-weight:600; height:28px; border:none;">  └ N班</td><td><input type="number" value="' + (sn.t||0) + '" onchange="updateShiftCell(\'' + _ln + '\',\'N\',\'t\',this.value);syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;"></td><td><input type="number" value="' + (sn.o||0) + '" onchange="updateShiftCell(\'' + _ln + '\',\'N\',\'o\',this.value);syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;" class="' + ((sn.o||0) >= (sn.t||0) ? '' : 'val-danger-bg') + '"></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td colspan="2"><span style="color:#94a3b8;font-size:10px;">-</span></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td><input type="text" readonly value="' + (Number(sn.o||0)-Number(sn.t||0)) + '" class="' + (Number(sn.o||0) < Number(sn.t||0) ? 'val-danger' : 'val-success') + '" style="font-size:11px;"></td></tr>';
                            }
                        }
                    } else {
                        wData.dLines.forEach(ld => {
                            let lossL = ld.o < ld.t ? (ld.o - ld.t) : 0;
                            htmlStr += `<tr style="background:rgba(240, 249, 255, 0.4);"><td style="text-align:left; padding-left:45px; vertical-align:middle; height:34px; border:none;"><span style="color:var(--midea-blue); font-weight:800; margin-right:4px;">└</span><input type="text" id="inp_d_${ld.id}_n" value="${ld.name}" style="width:65%; text-align:left; border-bottom:1px dashed var(--midea-blue); font-weight:800; color:var(--midea-blue); background:transparent;" onchange="updateDLine('${ws}', '${ld.id}', 'name', this.value)"><i class="fa-solid fa-trash-can" style="color:var(--danger); cursor:pointer; margin-left:8px; opacity:0.7; transition:0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7" onclick="delDLine('${ws}', '${ld.id}')"></i></td><td><input type="number" id="inp_d_${ld.id}_t" value="${ld.t}" onchange="updateDLine('${ws}', '${ld.id}', 't', this.value)"></td><td><input type="number" id="inp_d_${ld.id}_o" value="${ld.o}" onchange="updateDLine('${ws}', '${ld.id}', 'o', this.value)"></td><td><input type="number" id="inp_d_${ld.id}_h" value="${ld.h}" onchange="updateDLine('${ws}', '${ld.id}', 'h', this.value)"></td><td colspan="2"><span style="color:#94a3b8; font-size:11px !important;">-</span></td><td><input type="text" readonly value="-"></td><td><input type="text" readonly value="${lossL===0?t('normal'):lossL}" class="${lossL<0?'val-danger':''}"></td></tr>`;
                        });
                        htmlStr += `<tr style="background:rgba(240, 249, 255, 0.2);"><td colspan="8" style="text-align:center; height: 34px;"><button class="btn" style="display:inline-flex; border:1px dashed rgba(0,163,224,0.3); color:var(--midea-blue); background:rgba(255,255,255,0.5); font-size:12px !important; margin:0 auto; box-shadow:none;" onclick="addDLine('${ws}')"><i class="fa-solid fa-plus"></i> ${t('add_line')}</button></td></tr>`;
                    }
                }
                htmlStr += `<tr class="row-spacer"><td colspan="8"></td></tr>`;
            });
            // 第二部分:新增独立产线产出指标(H电机线、F电机线、S系列电机线、曲轴线)- 带班次输入
            htmlStr += '<tr><td colspan="8" style="text-align:left; padding:12px 15px 8px; font-weight:900; color:var(--midea-blue); background:linear-gradient(90deg, rgba(0,163,224,0.08), transparent); border-radius:4px; font-size:13px;"><i class="fa-solid fa-microchip" style="margin-right:6px;"></i>独立产线产出指标</td></tr>';
            ['H_MOTOR', 'F_MOTOR', 'S_MOTOR', 'CRANK'].forEach(function(ws) {
                var wData = data[ws] || { t: 0, o: 0, h: 0, att: 0, head: 0, shifts: { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } } };
                var shifts = wData.shifts || { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } };
                var dShift = shifts.D || { t: 0, o: 0 };
                var nShift = shifts.N || { t: 0, o: 0 };
                var m = calcWsData(date, ws);
                var displayName = NEW_MOTOR_NAMES[ws] || ws;
                var lossVal = m.output < m.target ? (m.output - m.target) : 0;
                var lossColor = lossVal < 0 ? 'val-danger' : '';
                // 主行 - 使用updateMotorTotal直接编辑整条线产出
                htmlStr += '<tr class="row-parent"><td style="text-align:left; padding-left:8px; vertical-align:middle; height:36px; border-bottom:none;"><i class="fa-solid fa-circle" style="font-size:6px; color:var(--midea-blue); margin-right:6px;"></i><span style="font-weight:900;">'+displayName+'</span><span id="ach-'+ws+'" style="margin-left:6px;font-size:10px;font-weight:800;"></span></td><td><input type="number" id="inp_'+ws+'_t" value="'+(wData.t||0)+'" onchange="updateMotorTotal(\''+ws+'\', \'t\', this.value)" title="直接编辑整条线目标产出"></td><td><input type="number" id="inp_'+ws+'_o" value="'+(wData.o||0)+'" onchange="updateMotorTotal(\''+ws+'\', \'o\', this.value)" title="直接编辑整条线实际产出"></td><td><input type="number" id="inp_'+ws+'_h" value="'+(wData.h||0)+'" onchange="updateCell(\''+ws+'\', \'h\', this.value)"></td><td><input type="number" id="inp_'+ws+'_att" value="'+safeNum(wData.att)+'" onchange="updateCell(\''+ws+'\', \'att\', this.value)"></td><td><input type="number" id="inp_'+ws+'_head" value="'+safeNum(wData.head)+'" onchange="updateCell(\''+ws+'\', \'head\', this.value)"></td><td><input type="text" readonly id="inp_'+ws+'_upph" value="'+m.upph+'" class="'+(m.upph>=23?'val-success':'val-danger')+'"></td><td><input type="text" readonly id="inp_'+ws+'_loss" value="'+(lossVal===0?'0':lossVal)+'" class="'+lossColor+'"></td></tr>';
                // 白班行
                htmlStr += '<tr style="background:rgba(245, 250, 255, 0.6);"><td style="text-align:left; padding-left:45px; color:var(--midea-blue); font-size:11px; font-weight:600; height:28px; border:none;">  └ 白班</td><td><input type="number" value="'+(dShift.t||0)+'" onchange="updateMotorShift(\''+ws+'\', \'D\', \'t\', this.value); syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;"></td><td><input type="number" value="'+(dShift.o||0)+'" onchange="updateMotorShift(\''+ws+'\', \'D\', \'o\', this.value); syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;" class="'+((dShift.o||0) >= (dShift.t||0) ? '' : 'val-danger-bg')+'"></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td colspan="2"><span style="color:#94a3b8;font-size:10px;">-</span></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td><input type="text" readonly value="'+(Number(dShift.o||0)-Number(dShift.t||0))+'" class="'+(Number(dShift.o||0) < Number(dShift.t||0) ? 'val-danger' : 'val-success')+'" style="font-size:11px;"></td></tr>';
                // 夜班行
                htmlStr += '<tr style="background:rgba(245, 250, 255, 0.4);"><td style="text-align:left; padding-left:45px; color:var(--midea-blue); font-size:11px; font-weight:600; height:28px; border:none;">  └ 夜班</td><td><input type="number" value="'+(nShift.t||0)+'" onchange="updateMotorShift(\''+ws+'\', \'N\', \'t\', this.value); syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;"></td><td><input type="number" value="'+(nShift.o||0)+'" onchange="updateMotorShift(\''+ws+'\', \'N\', \'o\', this.value); syncInputToProdReport()" style="width:65px;padding:2px 4px;font-size:11px;" class="'+((nShift.o||0) >= (nShift.t||0) ? '' : 'val-danger-bg')+'"></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td colspan="2"><span style="color:#94a3b8;font-size:10px;">-</span></td><td><span style="color:#94a3b8;font-size:10px;">-</span></td><td><input type="text" readonly value="'+(Number(nShift.o||0)-Number(nShift.t||0))+'" class="'+(Number(nShift.o||0) < Number(nShift.t||0) ? 'val-danger' : 'val-success')+'" style="font-size:11px;"></td></tr>';
                htmlStr += '<tr class="row-spacer"><td colspan="8"></td></tr>';
            });
            tbody.innerHTML = htmlStr;
            // 调试:检查表格是否渲染
            console.log('renderInput: 表格渲染完成,行数:', document.querySelectorAll('#inputTbody tr').length);
            // 达成率即时可视化
            PRO_ORDER.forEach(function(ws) {
                var wData = calcWsData(date, ws);
                var badge = document.getElementById('ach-' + ws);
                if(badge && wData.target > 0) {
                    var rate = (wData.output / wData.target * 100).toFixed(0);
                    var color = rate >= 95 ? 'var(--success)' : (rate >= 80 ? 'var(--warning)' : 'var(--danger)');
                    var icon = rate >= 95 ? 'fa-check-circle' : (rate >= 80 ? 'fa-exclamation-circle' : 'fa-times-circle');
                    badge.innerHTML = '<span style="display:inline-flex;align-items:center;gap:2px;color:'+color+'"><i class="fa-solid '+icon+'" style="font-size:9px;"></i>'+rate+'%</span>';
                } else if(badge) {
                    badge.innerHTML = '';
                }
            });
            // 同步录入数据至看板UPPH表
            syncInputToProdReport(null, true);

            // 初始化Excel网格键盘导航
            initExcelNavigation();
        }

        // ================= Excel交互系统(网格导航+框选+复制粘贴) =================
        window.excelNav = {
            grid: [],
            active: null,
            activeR: -1,
            activeC: -1,
            mouseDown: false,
            selection: new Set(),
            _dragStartRow: null,
            _dragStartCol: null,
            _keyHandler: null // 缓存键盘处理器引用
        };

        // 每次render后调用(此时tbody已存在)
        function initExcelNavigation() {
            var tbody = document.getElementById('inputTbody');
            if (!tbody) return;
            // 构建网格索引
            var ng = [];
            Array.from(tbody.rows || []).forEach(function(tr) {
                if (tr.classList.contains('row-spacer')) return;
                var ins = tr.querySelectorAll('td input, td select');
                if (ins.length < 2) return;
                ng.push(Array.from(ins));
            });
            window.excelNav.grid = ng;
            ng.forEach(function(row, ri) {
                row.forEach(function(inp, ci) {
                    inp.dataset.gr = ri;
                    inp.dataset.gc = ci;
                });
            });

            // ★ 一次性安装事件监听器(只装一次)
            if (!tbody._excelReady) {
                tbody._excelReady = true;

                // --- 鼠标按下:开始框选 ---
                tbody.addEventListener('mousedown', function(e) {
                    var inp = e.target.closest('#inputTbody input, #inputTbody select');
                    if (!inp || !inp.closest('#inputTbody')) return;
                    var ri = parseInt(inp.dataset.gr);
                    var ci = parseInt(inp.dataset.gc);
                    if (isNaN(ri) || isNaN(ci)) return;
                    // 清除旧选中
                    document.querySelectorAll('#inputTbody td.selected').forEach(function(el) {
                        el.classList.remove('selected');
                    });
                    window.excelNav.selection.clear();
                    // 选中当前格
                    var td = inp.closest('td');
                    if (td) {
                        td.classList.add('selected');
                        window.excelNav.selection.add(td);
                    }
                    // 记录拖选起点
                    window.excelNav.mouseDown = true;
                    window.excelNav._dragStartRow = ri;
                    window.excelNav._dragStartCol = ci;
                    // 不阻止默认--让input自然获得焦点
                });

                // --- 鼠标移入:扩展框选范围 ---
                tbody.addEventListener('mouseover', function(e) {
                    if (!window.excelNav.mouseDown) return;
                    var inp = e.target.closest('#inputTbody input, #inputTbody select');
                    if (!inp) return;
                    var ri = parseInt(inp.dataset.gr);
                    var ci = parseInt(inp.dataset.gc);
                    if (isNaN(ri) || isNaN(ci)) return;
                    var dsr = window.excelNav._dragStartRow;
                    var dsc = window.excelNav._dragStartCol;
                    if (dsr == null || dsc == null) return;
                    var g = window.excelNav.grid;
                    var r1 = Math.min(dsr, ri), r2 = Math.max(dsr, ri);
                    var c1 = Math.min(dsc, ci), c2 = Math.max(dsc, ci);
                    document.querySelectorAll('#inputTbody td.selected').forEach(function(el) {
                        el.classList.remove('selected');
                    });
                    window.excelNav.selection.clear();
                    for (var r = r1; r <= r2; r++) {
                        var row = g[r];
                        if (!row) continue;
                        for (var c = c1; c <= c2; c++) {
                            if (c >= row.length) break;
                            var td = row[c].closest('td');
                            if (td) {
                                td.classList.add('selected');
                                window.excelNav.selection.add(td);
                            }
                        }
                    }
                });

                // --- 焦点进入:高亮当前单元格+行 ---
                tbody.addEventListener('focusin', function(e) {
                    var inp = e.target.closest('#inputTbody input, #inputTbody select');
                    if (!inp) return;
                    var ri = parseInt(inp.dataset.gr);
                    var ci = parseInt(inp.dataset.gc);
                    if (isNaN(ri) || isNaN(ci)) return;
                    window.excelNav.active = inp;
                    window.excelNav.activeR = ri;
                    window.excelNav.activeC = ci;
                    var td = inp.closest('td');
                    if (td) {
                        document.querySelectorAll('.excel-active-cell').forEach(function(el) {
                            el.classList.remove('excel-active-cell');
                        });
                        td.classList.add('excel-active-cell');
                        // 滚动到可见区域
                        td.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                    var tr = inp.closest('tr');
                    if (tr) {
                        document.querySelectorAll('.excel-active-row').forEach(function(el) {
                            el.classList.remove('excel-active-row');
                        });
                        tr.classList.add('excel-active-row');
                    }
                });

                // --- 网格键盘导航(方向键) ---
                if (!window.excelNav._keyHandler) {
                    window.excelNav._keyHandler = function(e) {
                        // 只处理在 inputTbody 内的方向键
                        var el = e.target;
                        if (!el || !el.closest('#inputTbody')) return;
                        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                        e.preventDefault();
                        var nav = window.excelNav;
                        var g = nav.grid;
                        if (!g.length) return;
                        var r = nav.activeR;
                        var c = nav.activeC;
                        if (r < 0 || c < 0) return;
                        var nr = r, nc = c;
                        if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
                        else if (e.key === 'ArrowDown') nr = Math.min(g.length - 1, r + 1);
                        else if (e.key === 'ArrowLeft') {
                            nc = c - 1;
                            if (nc < 0 && r > 0) { nr = r - 1; var prow = g[nr]; nc = prow ? prow.length - 1 : 0; }
                        }
                        else if (e.key === 'ArrowRight') {
                            nc = c + 1;
                            var crow = g[nr];
                            if (nc >= (crow ? crow.length : 0) && nr < g.length - 1) { nr = nr + 1; nc = 1; }
                        }
                        // 安全访问目标
                        if (nr < 0 || nr >= g.length) return;
                        var targetRow = g[nr];
                        if (!targetRow) return;
                        if (nc < 0 || nc >= targetRow.length) return;
                        var target = targetRow[nc];
                        if (target && !target.readOnly) {
                            target.focus();
                            target.select();
                        } else if (target) {
                            target.focus();
                        }
                    };
                    // 移除旧监听再安装新监听
                    document.removeEventListener('keydown', window.excelNav._keyHandler);
                    document.addEventListener('keydown', window.excelNav._keyHandler);
                }
            }
        }

        // -------- 鼠标松开:停止拖选 --------
        document.addEventListener('mouseup', function() {
            window.excelNav.mouseDown = false;
        });

        // ================= 复制/粘贴/清除(支持多单元格) =================
        function getSelectedGridData() {
            // 从选中单元格构建行x列矩阵
            var cells = Array.from(window.excelNav.selection);
            if (cells.length === 0) {
                var a = window.excelNav.active;
                return a ? [[a]] : null;
            }
            // 按grid坐标分组找出范围
            var n = window.excelNav;
            var g = n.grid;
            var minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
            cells.forEach(function(td) {
                var inp = td.querySelector('input, select');
                if (!inp) return;
                var ri = parseInt(inp.dataset.gr);
                var ci = parseInt(inp.dataset.gc);
                if (!isNaN(ri)) { minR = Math.min(minR, ri); maxR = Math.max(maxR, ri); }
                if (!isNaN(ci)) { minC = Math.min(minC, ci); maxC = Math.max(maxC, ci); }
            });
            if (minR === Infinity) return null;
            var matrix = [];
            for (var r = minR; r <= maxR; r++) {
                var row = g[r];
                if (!row) continue;
                var rowData = [];
                for (var c = minC; c <= maxC; c++) {
                    var inp = row[c];
                    rowData.push(inp ? inp.value || '' : '');
                }
                matrix.push(rowData);
            }
            return matrix;
        }

        function copySelectedCells() {
            var matrix = getSelectedGridData();
            if (!matrix || matrix.length === 0 || matrix[0].length === 0) {
                showToast('fa-solid fa-info-circle', '没有可复制的内容', 'info');
                return;
            }
            var text = matrix.map(function(row) { return row.join('\t'); }).join('\r\n');
            navigator.clipboard.writeText(text).then(function() {
                var count = matrix.reduce(function(s, r) { return s + r.length; }, 0);
                showToast('fa-solid fa-check', '已复制 ' + count + ' 个单元格 (Excel格式)', 'success');
            }).catch(function() {
                var ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            });
        }

        function pasteToCells() {
            var n = window.excelNav;
            var active = n.active;
            if (!active) {
                showToast('fa-solid fa-xmark', '请先点击一个单元格', 'warning');
                return;
            }
            navigator.clipboard.readText().then(function(clipText) {
                if (!clipText || !clipText.trim()) return;
                // 解析粘贴数据(支持 Excel 制表符分隔格式)
                var rows = clipText.split(/\r?\n/);
                var pasteData = [];
                rows.forEach(function(line) {
                    if (line.trim() === '' && pasteData.length > 0) return;
                    var cells = line.split('\t');
                    pasteData.push(cells);
                });
                if (pasteData.length === 0) return;
                var startR = n.activeR;
                var startC = n.activeC;
                if (startR < 0 || startC < 0) return;
                var g = n.grid;
                var pasted = 0;
                for (var pr = 0; pr < pasteData.length; pr++) {
                    var gr = startR + pr;
                    if (gr >= g.length) break;
                    var row = g[gr];
                    if (!row) continue;
                    for (var pc = 0; pc < pasteData[pr].length; pc++) {
                        var gc = startC + pc;
                        if (gc >= row.length) break;
                        var inp = row[gc];
                        if (inp && !inp.readOnly && inp.type !== 'hidden') {
                            var val = pasteData[pr][pc].trim();
                            inp.value = val;
                            inp.dispatchEvent(new Event('change', { bubbles: true }));
                            pasted++;
                        }
                    }
                }
                showToast('fa-solid fa-check', '已粘贴 ' + pasted + ' 个单元格', 'success');
            }).catch(function() {
                showToast('fa-solid fa-xmark', '无法读取剪贴板 (请允许剪贴板权限)', 'error');
            });
        }

        function clearSelectedCells() {
            var cells = Array.from(window.excelNav.selection);
            if (cells.length === 0) {
                var a = window.excelNav.active;
                if (!a || a.readOnly) return;
                a.value = '0';
                a.dispatchEvent(new Event('change', { bubbles: true }));
                showToast('fa-solid fa-check', '已清除', 'success');
                return;
            }
            var cleared = 0;
            cells.forEach(function(td) {
                var inp = td.querySelector('input:not([readonly]), select');
                if (inp) {
                    inp.value = '0';
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    cleared++;
                }
            });
            showToast('fa-solid fa-check', '已清除 ' + cleared + ' 个单元格', 'success');
        }

        window.excelSelection = window.excelNav;

        // 全局快捷键(Ctrl+C/V, Delete)- 仅用于 inputTbody 内的操作
        document.addEventListener('keydown', function(e) {
            // ★ 跳过文本框:允许正常粘贴(LOSS AI导入等)
            if (e.target && (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type === 'text'))) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); copySelectedCells(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); pasteToCells(); }
            if (e.key === 'Delete') {
                var el = e.target;
                if (el && el.closest('#inputTbody')) { e.preventDefault(); clearSelectedCells(); }
            }
        });
        var chartMon = null;
        // ================= 图表全局状态:WS 可见性 =================
        window.monitorChartWs = {};
        window.monitorChartMode = 'aggregate';
        function renderMonitor() {
            const date = window.safeDOM.val("globalDate"); let list = [];
            PRO_ORDER.forEach(ws => { let m = calcWsData(date, ws); list.push({ ws, out: m.output, hrs: m.hours, tgt: m.target, upph: m.upph, loss: m.loss }); });
            let p2 = list.find(x => x.ws === 'PRO2');
            document.getElementById('kpiGat').innerText = p2.out.toLocaleString(); document.getElementById('kpiMissing').innerText = p2.loss < 0 ? p2.loss : 0;
            list.sort((a,b) => b.upph - a.upph); const rankUl = document.getElementById('monitorRank'); let htmlStr = '';
            list.forEach((r, i) => {
                htmlStr += `<li class="rank-item"><div class="rank-num">${i+1}</div><div class="rank-info"><div><span style="color:var(--midea-blue)">产线</span><b>${r.ws}</b></div><div><span>产出 / 工时</span><b>${r.out.toLocaleString()} / ${r.hrs}H</b></div><div><span>差异</span><b class="${r.loss<0?'val-danger':''}">${r.loss===0?'0':r.loss}</b></div><div><span>UPPH</span><b class="${r.upph>=23?'val-success':'val-danger'}" style="font-size:1.1rem !important;">${r.upph.toFixed(2)}</b></div></div></li>`;
            });
            rankUl.innerHTML = htmlStr;
            // 初始化 WS 可见性
            if(Object.keys(window.monitorChartWs).length === 0) {
                PRO_ORDER.forEach(function(ws){ window.monitorChartWs[ws] = false; });
                window.monitorChartWs['PRO2'] = true;
            }
            // 渲染 WS 标签(使用中文名称)
            var tagsEl = document.getElementById('chartWsTags');
            if(tagsEl) {
                tagsEl.innerHTML = PRO_ORDER.map(function(ws) {
                    var visible = window.monitorChartWs[ws];
                    var bg = visible ? 'var(--midea-blue)' : '#cbd5e1';
                    var color = visible ? 'white' : '#94a3b8';
                    var displayName = NEW_MOTOR_NAMES[ws] || ws;
                    return '<span onclick="toggleChartWs(\''+ws+'\')" style="cursor:pointer;padding:2px 10px;border-radius:12px;background:'+bg+';color:'+color+';font-size:11px;font-weight:700;transition:0.2s;">'+displayName+'</span>';
                }).join('');
            }
            // 计算可见 WS 数据
            var visibleList = list.filter(function(x){ return window.monitorChartWs[x.ws]; });
            var visibleCount = visibleList.length;
            // 标题模式切换
            var titleText = '产出达成对比';
            if(visibleCount === 1) {
                var wsName = visibleList[0].ws;
                var isMotorLine = ['H_MOTOR', 'F_MOTOR', 'S_MOTOR', 'CRANK'].indexOf(wsName) !== -1;
                if(isMotorLine) {
                    titleText = (NEW_MOTOR_NAMES[wsName] || wsName) + ' 产出达成';
                } else if(wsName === 'PRO2') {
                    titleText = wsName + ' 线体·班次产出明细';
                } else {
                    titleText = wsName + ' 产出达成';
                }
            }
            document.getElementById('chartTitleText').innerText = titleText;
            if (typeof Chart !== 'undefined') {
                const ctx = document.getElementById('chartMonitor').getContext('2d'); if(chartMon) { chartMon.destroy(); chartMon = null; }
                if(visibleCount === 1) {
                    // 单一 WS → 显示该WS下班次达成明细
                    var singleWs = visibleList[0].ws;

                    if(singleWs === 'PRO2') {
                        // PRO2 特殊处理:显示 A/B/C/D 线体的白班/夜班
                        var shiftGroups = [];
                        if(db.prod[date] && db.prod[date].PRO2 && db.prod[date].PRO2.lines) {
                            var lines = db.prod[date].PRO2.lines;
                            Object.keys(lines).sort().forEach(function(ln) {
                                var line = lines[ln];
                                if(line.shifts) {
                                    var gLabel = ln.replace('LINE ','')+'线';
                                    ['D','N'].forEach(function(sh) {
                                        if(ln === 'LINE D' && sh === 'N') return; // LINE D has no N班
                                        var sd = line.shifts[sh] || {t:0,o:0};
                                        shiftGroups.push({
                                            group: gLabel,
                                            label: sh+'班',
                                            t: Number(sd.t) || 0,
                                            o: Number(sd.o) || 0
                                        });
                                    });
                                }
                            });
                        }
                        if(shiftGroups.length === 0) {
                            // 无录入数据时降级显示
                            ['A-D','A-N','B-D','B-N','C-D','C-N','D-D'].forEach(function(sl, idx) {
                                var base = visibleList[0].out / 8;
                                shiftGroups.push({
                                    group: sl.charAt(0)+'线',
                                    label: sl.charAt(2)+'班',
                                    t: Math.round(base),
                                    o: Math.round(base * (0.85 + idx * 0.05))
                                });
                            });
                        }
                        var sLabels = shiftGroups.map(function(g){ return g.group+'·'+g.label; });
                        var sTargets = shiftGroups.map(function(g){ return g.t; });
                        var sActuals = shiftGroups.map(function(g){ return g.o; });
                        var sColors = shiftGroups.map(function(g){ return g.o >= g.t ? 'rgba(0,146,216,0.85)' : 'rgba(225,29,72,0.8)'; });
                        chartMon = new Chart(ctx, {
                            type: 'bar',
                            data: {
                                labels: sLabels,
                                datasets: [
                                    { label:'目标', data: sTargets, backgroundColor: 'rgba(203,213,225,0.7)', borderRadius: 4 },
                                    { label:'实际', data: sActuals, backgroundColor: sColors, borderRadius: 4 }
                                ]
                            },
                            options: {
                                responsive: true, maintainAspectRatio: false,
                                animation: { duration: 400, easing: 'easeOutQuart' },
                                layout: { padding: { top: 22 } },
                                plugins: {
                                    legend: { display: true, position: 'top', labels: { font: { size: 11, weight: 'bold' } } },
                                    datalabels: {
                                        align: 'top', anchor: 'end', offset: -2,
                                        color: function(c) { return c.datasetIndex === 1 ? '#0092D8' : '#64748b'; },
                                        font: { weight: '800', size: 10 },
                                        formatter: function(v) { return v ? v.toLocaleString() : '0'; }
                                    }
                                },
                                scales: {
                                    y: { beginAtZero: true, grace: '15%', grid: { color: 'rgba(0,146,216,0.06)' }, ticks: { font: { size: 10, weight: 'bold' } } },
                                    x: { grid: { display: false }, ticks: { maxRotation: 35, font: { size: 9, weight: 'bold' } } }
                                }
                            }
                        });
                    } else {
                        // 其他车间:显示白班目标、白班实际、夜班目标、夜班实际
                        var wsData = db.prod[date] && db.prod[date][singleWs] ? db.prod[date][singleWs] : {};
                        var shifts = wsData.shifts || { D: { t: 0, o: 0 }, N: { t: 0, o: 0 } };
                        var dShift = shifts.D || { t: 0, o: 0 };
                        var nShift = shifts.N || { t: 0, o: 0 };
                        var displayName = NEW_MOTOR_NAMES[singleWs] || singleWs;
                        var sLabels = ['白班目标', '白班实际', '夜班目标', '夜班实际'];
                        var sData = [
                            Number(dShift.t) || 0,
                            Number(dShift.o) || 0,
                            Number(nShift.t) || 0,
                            Number(nShift.o) || 0
                        ];
                        var sColors = [
                            'rgba(203,213,225,0.7)',
                            sData[1] >= sData[0] ? 'rgba(0,146,216,0.85)' : 'rgba(225,29,72,0.8)',
                            'rgba(203,213,225,0.7)',
                            sData[3] >= sData[2] ? 'rgba(0,146,216,0.85)' : 'rgba(225,29,72,0.8)'
                        ];
                        chartMon = new Chart(ctx, {
                            type: 'bar',
                            data: {
                                labels: sLabels,
                                datasets: [{ label: displayName, data: sData, backgroundColor: sColors, borderRadius: 6 }]
                            },
                            options: {
                                responsive: true, maintainAspectRatio: false,
                                animation: { duration: 400, easing: 'easeOutQuart' },
                                layout: { padding: { top: 22 } },
                                plugins: {
                                    legend: { display: false },
                                    datalabels: {
                                        align: 'top', anchor: 'end', offset: -2,
                                        color: '#0092D8',
                                        font: { weight: '800', size: 12 },
                                        formatter: function(v) { return v ? v.toLocaleString() : '0'; }
                                    }
                                },
                                scales: {
                                    y: { beginAtZero: true, grace: '15%', grid: { color: 'rgba(0,146,216,0.06)' }, ticks: { font: { size: 11, weight: 'bold' } } },
                                    x: { grid: { display: false }, ticks: { font: { size: 12, weight: 'bold' } } }
                                }
                            }
                        });
                    }
                } else {
                    // 多WS → 标准对比图(确保每个柱子顶部有数字标签)
                    chartMon = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: visibleList.map(function(x){ return x.ws; }),
                            datasets: [
                                { label:'目标', data: visibleList.map(function(x){ return x.tgt; }), backgroundColor: '#cbd5e1', borderRadius:6 },
                                { label:'实际', data: visibleList.map(function(x){ return x.out; }), backgroundColor: visibleList.map(function(x){ return x.out>=x.tgt ? 'rgba(0, 146, 216, 0.85)' : 'rgba(225, 29, 72, 0.8)'; }), borderRadius:6 }
                            ]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            animation: { duration: 400, easing: 'easeOutQuart' },
                            layout: { padding: { top: 22 } },
                            plugins: {
                                legend: { display: false },
                                datalabels: {
                                    align: 'top', anchor: 'end', offset: -2,
                                    color: function(c) { return c.datasetIndex === 1 ? '#0092D8' : '#64748b'; },
                                    font: { weight: '800', size: 11 },
                                    formatter: function(v) { return v ? v.toLocaleString() : '0'; }
                                }
                            },
                            scales:{
                                y: { beginAtZero: true, grace: '15%', grid: { color: 'rgba(0,146,216,0.06)' }, ticks: { font: { size: 10, weight: 'bold' } } },
                                x: { grid: { display: false }, ticks: { font: { size: 11, weight: 'bold' } } }
                            }
                        }
                    });
                }
            }
        }
        // ================= WS 图表可见性切换 =================
        window.toggleChartWs = function(ws) {
            window.monitorChartWs[ws] = !window.monitorChartWs[ws];
            // 确保至少有一个可见
            var anyVisible = PRO_ORDER.some(function(w){ return window.monitorChartWs[w]; });
            if(!anyVisible) window.monitorChartWs[ws] = true;
            renderMonitor();
        };
        // ================= 录入数据联动至 UPPH 达成 =================
        // ★ 真正的 syncInputToProdReport 逻辑(可被防抖或直通调用)
        function _execSyncInputToProdReport(date) {
            if(!date) date = window.safeDOM.val("globalDate");
            if(!db.prodReport) db.prodReport = {};
            if(!db.prodReport[date]) db.prodReport[date] = { upph: { pic:'Mr.PAN', baseline:1.29, dailyOutput:0, dailyHr:0, dailyUPPH:0, dailyRate:0, monthOutput:0, monthHr:0, monthUPPH:0, monthRate:0 }, shifts: [], notes: '' };
            var totalO = 0, totalH = 0;
            PRO_ORDER.forEach(function(ws) {
                if(db.prod[date] && db.prod[date][ws]) {
                    totalO += Number(db.prod[date][ws].o || 0);
                    totalH += Number(db.prod[date][ws].h || 0);
                }
            });
            var data = db.prodReport[date];
            data.upph.dailyOutput = totalO;
            data.upph.dailyHr = totalH;
            data.upph.dailyUPPH = totalH > 0 ? parseFloat((totalO / totalH).toFixed(2)) : 0;
            // 从PRO2线体班次构建shift明细
            data.shifts = [];
            try { ensureProdData(date); } catch(e){}
            if(db.prod[date] && db.prod[date].PRO2 && db.prod[date].PRO2.lines) {
                Object.keys(db.prod[date].PRO2.lines).forEach(function(lineName) {
                    var line = db.prod[date].PRO2.lines[lineName];
                    if(line.shifts) {
                        Object.keys(line.shifts).forEach(function(shift) {
                            if(lineName === 'LINE D' && shift === 'N') return;
                            var sd = line.shifts[shift];
                            data.shifts.push({
                                line: lineName.replace('LINE ',''),
                                shift: shift,
                                target: Number(sd.t) || 0,
                                actual: Number(sd.o) || 0,
                                rate: Number(sd.t) > 0 ? parseFloat((Number(sd.o)/Number(sd.t)*100).toFixed(2)) : 0,
                                rank: 0, mTarget: 0, mActual: 0, mRate: 0, mRank: 0
                            });
                        });
                    }
                });
            }
            if(data.shifts.length > 0) {
                var sorted = data.shifts.map(function(s,i){ return {idx:i,rate:s.rate}; }).filter(function(s){return s.rate>0;}).sort(function(a,b){return b.rate-a.rate;});
                sorted.forEach(function(s,pos){ data.shifts[s.idx].rank = pos+1; });
            }
            triggerAutoSave();
            try { renderProdReport(); } catch(e){ console.warn('renderProdReport sync failed:', e); }
        }
        window.syncInputToProdReport = function(date, immediate) {
            if(immediate) { _execSyncInputToProdReport(date); return; }
            clearTimeout(window._syncInputTimer);
            window._syncInputTimer = setTimeout(function() { _execSyncInputToProdReport(date); }, 300);
        };
        // ================= GAT Output & UPPH Achievement Report =================
                window.getProdReportDate = function() {
            var d = window.prodReportDate || window.safeDOM.val('globalDate');
            return typeof d === 'string' ? d : '';
        };
        function ensureProdReportData(date) {
            if (!db.prodReport) db.prodReport = {};
            if (!db.prodReport[date]) {
                db.prodReport[date] = {
                    upph: { pic: 'Mr.PAN', baseline: 1.29, dailyOutput: 24675, dailyHr: 9845, dailyUPPH: 2.51, dailyRate: 94.30, monthOutput: 446306, monthHr: 225751, monthUPPH: 1.98, monthRate: 53.25 },
                    shifts: [
                        { line: 'A', shift: 'D', target: 3500, actual: 4041, rate: 115.46, rank: 1, mTarget: 154000, mActual: 138312, mRate: 89.81, mRank: 3 },
                        { line: 'A', shift: 'N', target: 3500, actual: 3800, rate: 108.57, rank: 3, mTarget: 0, mActual: 0, mRate: 0, mRank: 7 },
                        { line: 'B', shift: 'D', target: 4200, actual: 3891, rate: 92.64, rank: 6, mTarget: 179400, mActual: 161136, mRate: 89.82, mRank: 2 },
                        { line: 'B', shift: 'N', target: 4200, actual: 4002, rate: 95.29, rank: 5, mTarget: 0, mActual: 0, mRate: 0, mRank: 7 },
                        { line: 'C', shift: 'D', target: 3500, actual: 3876, rate: 110.74, rank: 2, mTarget: 133000, mActual: 129876, mRate: 97.65, mRank: 1 },
                        { line: 'C', shift: 'N', target: 3500, actual: 3354, rate: 95.83, rank: 4, mTarget: 0, mActual: 0, mRate: 0, mRank: 7 },
                        { line: 'D', shift: 'D', target: 2800, actual: 2626, rate: 93.79, rank: 7, mTarget: 56200, mActual: 16982, mRate: 30.22, mRank: 4 }
                    ],
                    notes: ''
                };
            }
            return db.prodReport[date];
        }
        function calcUPPHRate() {
            var dailyO = safeNum(document.getElementById('upphDailyO').value);
            var dailyH = safeNum(document.getElementById('upphDailyH').value);
            var baseline = safeNum(document.getElementById('upphBaseline').value);

            // 计算每日UPPH和提升率
            var dUPPH = dailyH > 0 ? (dailyO / dailyH) : 0;
            var dRate = baseline > 0 ? ((dUPPH - baseline) / baseline * 100) : 0;
            document.getElementById('upphDailyUPPH').textContent = dUPPH.toFixed(2);
            document.getElementById('upphDailyRate').textContent = dRate.toFixed(2) + '%';

            // 自动计算月度累计(当月之前所有日期的累计)
            var currentDate = window.getProdReportDate();
            var currentMonth = currentDate.substring(0, 7); // YYYY-MM格式

            // 获取当月所有日期的数据并累计
            var monthTotalOutput = 0;
            var monthTotalHours = 0;

            if (db.prodReport) {
                Object.keys(db.prodReport).forEach(function(date) {
                    if (date.startsWith(currentMonth) && date <= currentDate) {
                        var dayData = db.prodReport[date];
                        if (dayData.upph) {
                            monthTotalOutput += safeNum(dayData.upph.dailyOutput) || 0;
                            monthTotalHours += safeNum(dayData.upph.dailyHr) || 0;
                        }
                    }
                });
            }

            // 加上当天的数据
            monthTotalOutput += dailyO;
            monthTotalHours += dailyH;

            // 更新月度累计输入框
            document.getElementById('upphMonthO').value = monthTotalOutput;
            document.getElementById('upphMonthH').value = monthTotalHours;

            // 计算月度UPPH和提升率
            var mUPPH = monthTotalHours > 0 ? (monthTotalOutput / monthTotalHours) : 0;
            var mRate = baseline > 0 ? ((mUPPH - baseline) / baseline * 100) : 0;
            document.getElementById('upphMonthUPPH').textContent = mUPPH.toFixed(2);
            document.getElementById('upphMonthRate').textContent = mRate.toFixed(2) + '%';

            saveProdReport();
        }
        function computeShiftRanks() {
            var date = window.getProdReportDate();
            var data = ensureProdReportData(date);
            var rows = data.shifts;
            // Daily rank (desc by rate)
            var dailySorted = rows.map(function(r, i) { return { idx: i, rate: r.rate }; }).filter(function(r) { return r.rate > 0; }).sort(function(a, b) { return b.rate - a.rate; });
            dailySorted.forEach(function(r, pos) { rows[r.idx].rank = pos + 1; });
            // Monthly rank
            var monthlySorted = rows.map(function(r, i) { return { idx: i, rate: safeNum(r.mRate) }; }).filter(function(r) { return r.rate > 0; }).sort(function(a, b) { return b.rate - a.rate; });
            monthlySorted.forEach(function(r, pos) { rows[r.idx].mRank = pos + 1; });
        }
        function recalcShiftTotal() {
            var date = window.getProdReportDate();
            var data = ensureProdReportData(date);
            var rows = data.shifts;
            var total = { line: 'TTL', shift: 'D/N', target: 0, actual: 0, rate: 0, rank: '-', mTarget: 0, mActual: 0, mRate: 0, mRank: '-' };
            rows.forEach(function(r) {
                total.target += safeNum(r.target);
                total.actual += safeNum(r.actual);
                total.mTarget += safeNum(r.mTarget);
                total.mActual += safeNum(r.mActual);
            });
            total.rate = total.target > 0 ? parseFloat((total.actual / total.target * 100).toFixed(2)) : 0;
            total.mRate = total.mTarget > 0 ? parseFloat((total.mActual / total.mTarget * 100).toFixed(2)) : 0;
            return total;
        }
        window.renderProdReport = function() {
            var date = window.getProdReportDate();
            if (typeof date !== 'string' || !date) { console.warn('renderProdReport: invalid date'); return; }
            // ★ 强制重建:始终确保db.prodReport[date]存在且有完整的shifts数据
            if(!db.prodReport) db.prodReport = {};
            try {
                // 从PRO2线体班次重建shifts
                db.prodReport[date] = db.prodReport[date] || { upph:{pic:'Mr.PAN',baseline:1.29,dailyOutput:0,dailyHr:0,dailyUPPH:0,dailyRate:0,monthOutput:0,monthHr:0,monthUPPH:0,monthRate:0}, shifts:[], notes:'' };
                var data = db.prodReport[date];
                data.shifts = [];
                if(!db.prod[date]) ensureProdData(date);
                var _lines = (db.prod[date] && db.prod[date].PRO2 && db.prod[date].PRO2.lines) ? db.prod[date].PRO2.lines : null;
                if(_lines) {
                    Object.keys(_lines).forEach(function(_ln) {
                        var _line = _lines[_ln];
                        if(!_line || !_line.shifts) return;
                        Object.keys(_line.shifts).forEach(function(_sh) {
                            if(_ln === 'LINE D' && _sh === 'N') return;
                            var _d = _line.shifts[_sh];
                            data.shifts.push({
                                line: _ln.replace('LINE ',''), shift: _sh,
                                target: Number(_d.t) || 0, actual: Number(_d.o) || 0,
                                rate: Number(_d.t) > 0 ? parseFloat((Number(_d.o)/Number(_d.t)*100).toFixed(2)) : 0,
                                rank: 0, mTarget: 0, mActual: 0, mRate: 0, mRank: 0
                            });
                        });
                    });
                }
                // 兜底:PRO2没数据则用静态默认值
                if(data.shifts.length === 0) {
                    data.shifts = [
                        {line:'A',shift:'D',target:3500,actual:4041,rate:115.46,rank:1,mTarget:154000,mActual:138312,mRate:89.81,mRank:3},
                        {line:'A',shift:'N',target:3500,actual:3800,rate:108.57,rank:3,mTarget:0,mActual:0,mRate:0,mRank:7},
                        {line:'B',shift:'D',target:4200,actual:3891,rate:92.64,rank:6,mTarget:179400,mActual:161136,mRate:89.82,mRank:2},
                        {line:'B',shift:'N',target:4200,actual:4002,rate:95.29,rank:5,mTarget:0,mActual:0,mRate:0,mRank:7},
                        {line:'C',shift:'D',target:3500,actual:3876,rate:110.74,rank:2,mTarget:133000,mActual:129876,mRate:97.65,mRank:1},
                        {line:'C',shift:'N',target:3500,actual:3354,rate:95.83,rank:4,mTarget:0,mActual:0,mRate:0,mRank:7},
                        {line:'D',shift:'D',target:2800,actual:2626,rate:93.79,rank:7,mTarget:56200,mActual:16982,mRate:30.22,mRank:4}
                    ];
                }
        } catch(e) { console.error('renderProdReport build failed:', e); }
            var row = data.upph || {pic:'Mr.PAN', baseline:1.29, dailyOutput:0, dailyHr:0, monthOutput:0, monthHr:0};
            // 同步日期到UPPH标题
            var dp = document.getElementById('upphDatePrefix');
            if(dp && date) {
                var parts = date.split('-');
                dp.innerText = parts[0] + '年' + parseInt(parts[1]) + '月' + parseInt(parts[2]) + '日 ';
            }
            // 同步标题日期到看板主标题
            var dt = document.getElementById('dash-dynamic-title');
            if(dt && date) {
                var parts = date.split('-');
                dt.innerText = parts[0] + '年' + parseInt(parts[1]) + '月' + parseInt(parts[2]) + '日 产出效率达成情况';
            }
            // UPPH row (may be removed)
            var el;
            el = document.getElementById('upphPIC'); if(el) el.value = row.pic || 'Mr.PAN';
            el = document.getElementById('upphBaseline'); if(el) el.value = row.baseline || 1.29;
            el = document.getElementById('upphDailyO'); if(el) el.value = row.dailyOutput || 0;
            el = document.getElementById('upphDailyH'); if(el) el.value = row.dailyHr || 0;
            el = document.getElementById('upphMonthO'); if(el) el.value = row.monthOutput || 0;
            el = document.getElementById('upphMonthH'); if(el) el.value = row.monthHr || 0;
            if(typeof calcUPPHRate==='function') try{calcUPPHRate()}catch(e){}
            // Shift rows with line merging
            computeShiftRanks();
            var shifts = data.shifts;
            var tbody = document.getElementById('shiftBody');
            // Build line groups for rowspan merging
            var lineGroups = [];
            var currentLine = null;
            shifts.forEach(function(r, idx) {
                if (r.line !== currentLine) {
                    lineGroups.push({ line: r.line, start: idx, count: 1 });
                    currentLine = r.line;
                } else {
                    lineGroups[lineGroups.length - 1].count++;
                }
            });
            // Determine last rank for each D/M (for prod-rank-last)
            var dailyActiveCount = shifts.filter(function(x) { return x.rate > 0; }).length;
            var monthlyActiveCount = shifts.filter(function(x) { return x.mRate > 0; }).length;
            // Line color mapping
            function getLineBg(line) {
                var upper = (line || '').toUpperCase().replace('LINE ', '');
                if (upper === 'A' || upper === 'C') return 'rgba(219, 234, 254, 0.25)';
                if (upper === 'B' || upper === 'D') return 'rgba(187, 247, 208, 0.25)';
                return '';
            }
            var htmlStr = '';
            shifts.forEach(function(r, idx) {
                // Determine which line group this row belongs to
                var groupIdx = -1;
                for (var gi = 0; gi < lineGroups.length; gi++) {
                    if (idx >= lineGroups[gi].start && idx < lineGroups[gi].start + lineGroups[gi].count) {
                        groupIdx = gi;
                        break;
                    }
                }
                var lineBg = getLineBg(r.line);
                var lineStyle = lineBg ? ' style="background:' + lineBg + '"' : '';
                // Rank styling
                var dailyRankSpan = '';
                if (r.rank === 1) {
                    dailyRankSpan = '<span class="prod-rank-1">🥇 ' + r.rank + '</span>';
                } else if (r.rank > 0 && r.rank === dailyActiveCount) {
                    dailyRankSpan = '<span class="prod-rank-last">' + r.rank + '</span>';
                } else {
                    dailyRankSpan = '<span>' + (r.rank > 0 ? r.rank : '-') + '</span>';
                }
                var monthlyRankSpan = '';
                if (r.mRank === 1) {
                    monthlyRankSpan = '<span class="prod-rank-1">🥇 ' + r.mRank + '</span>';
                } else if (r.mRank > 0 && r.mRank === monthlyActiveCount) {
                    monthlyRankSpan = '<span class="prod-rank-last">' + r.mRank + '</span>';
                } else {
                    monthlyRankSpan = '<span>' + (r.mRank > 0 ? r.mRank : '-') + '</span>';
                }
                // Line column: rowspan if first in group and count > 1
                var lineCell = '';
                if (idx === lineGroups[groupIdx].start) {
                    var count = lineGroups[groupIdx].count;
                    var rowspanAttr = count > 1 ? ' rowspan="' + count + '"' : '';
                    var mergedStyle = count > 1 ? ' style="font-size:16px; font-weight:900; vertical-align:middle;' + (lineBg ? ' background:' + lineBg : '') + '"' : (lineBg ? ' style="background:' + lineBg + '"' : '');
                    lineCell = '<td' + rowspanAttr + mergedStyle + '><input type="text" value="' + (r.line || '') + '" onchange="updateShiftField(' + idx + ',\'line\',this.value)" style="width:40px; font-weight:900; border:none; background:transparent; text-align:center;"></td>';
                }
                htmlStr += '<tr' + lineStyle + '>' +
                    lineCell +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><input type="text" value="' + (r.shift || '') + '" onchange="updateShiftField(' + idx + ',\'shift\',this.value)" style="width:30px; border:none; background:transparent; text-align:center;"></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><input type="number" value="' + (r.target || 0) + '" onchange="updateShiftField(' + idx + ',\'target\',this.value)"></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><input type="number" value="' + (r.actual || 0) + '" onchange="updateShiftField(' + idx + ',\'actual\',this.value)"></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><span class="prod-field">' + (r.rate ? r.rate.toFixed(2) + '%' : '0.00%') + '</span></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '>' + dailyRankSpan + '</td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><input type="number" value="' + (r.mTarget || 0) + '" onchange="updateShiftField(' + idx + ',\'mTarget\',this.value)"></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><input type="number" value="' + (r.mActual || 0) + '" onchange="updateShiftField(' + idx + ',\'mActual\',this.value)"></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '><span class="prod-field">' + (typeof r.mRate === 'number' ? r.mRate.toFixed(2) + '%' : '0.00%') + '</span></td>' +
                    '<td' + (lineBg ? ' style="background:' + lineBg + '"' : '') + '>' + monthlyRankSpan + '</td>' +
                    '<td style="width:25px; min-width:25px; padding:0;"><button class="prod-del-btn" onclick="deleteProdShift(' + idx + ')" title="Delete"><i class="fa-solid fa-trash-can"></i></button></td>' +
                    '</tr>';
            });
            // Total row (no line merging, no bg)
            var total = recalcShiftTotal();
            htmlStr += '<tr class="shift-ttl-row">' +
                '<td style="font-weight:900;">TTL</td><td>D/N</td>' +
                '<td>' + total.target + '</td>' +
                '<td>' + total.actual + '</td>' +
                '<td><span class="prod-field">' + total.rate.toFixed(2) + '%</span></td>' +
                '<td>-</td>' +
                '<td>' + total.mTarget + '</td>' +
                '<td>' + total.mActual + '</td>' +
                '<td><span class="prod-field">' + total.mRate.toFixed(2) + '%</span></td>' +
                '<td>-</td>' +
                '<td style="width:25px; min-width:25px;"></td>' +
                '</tr>';
            tbody.innerHTML = htmlStr;
            // Notes
            document.getElementById('prodNotes').value = data.notes || '';
        };
        window.updateShiftField = function(idx, field, val) {
            var date = window.getProdReportDate();
            var data = ensureProdReportData(date);
            if (field === 'target' || field === 'actual' || field === 'mTarget' || field === 'mActual') {
                data.shifts[idx][field] = safeNum(val);
            } else {
                data.shifts[idx][field] = val;
            }
            // Auto compute rate
            if (field === 'target' || field === 'actual') {
                var t = safeNum(data.shifts[idx].target);
                var a = safeNum(data.shifts[idx].actual);
                data.shifts[idx].rate = t > 0 ? parseFloat((a / t * 100).toFixed(2)) : 0;
            }
            if (field === 'mTarget' || field === 'mActual') {
                var mt = safeNum(data.shifts[idx].mTarget);
                var ma = safeNum(data.shifts[idx].mActual);
                data.shifts[idx].mRate = mt > 0 ? parseFloat((ma / mt * 100).toFixed(2)) : 0;
            }
            saveProdReport();
            renderProdReport();
        };
        window.addProdShiftRow = function() {
            var date = window.getProdReportDate();
            var data = ensureProdReportData(date);
            data.shifts.push({ line: '', shift: '', target: 0, actual: 0, rate: 0, rank: 0, mTarget: 0, mActual: 0, mRate: 0, mRank: 0 });
            saveProdReport();
            renderProdReport();
        };
        window.deleteProdShift = function(idx) {
            var date = window.getProdReportDate();
            var data = ensureProdReportData(date);
            data.shifts.splice(idx, 1);
            if (typeof forceSaveToFirebase === 'function') forceSaveToFirebase(); else triggerAutoSave();
            renderProdReport();
        };
        window.saveProdReport = function() {
            var date = window.getProdReportDate();
            if (!db.prodReport) db.prodReport = {};
            if (!db.prodReport[date]) db.prodReport[date] = { upph: {}, shifts: [], notes: '' };
            var data = db.prodReport[date];

            // 获取当前月份
            var currentMonth = date.substring(0, 7); // YYYY-MM格式

            // Read UPPH values from inputs
            data.upph = {
                pic: document.getElementById('upphPIC').value,
                baseline: safeNum(document.getElementById('upphBaseline').value),
                dailyOutput: safeNum(document.getElementById('upphDailyO').value),
                dailyHr: safeNum(document.getElementById('upphDailyH').value),
                dailyUPPH: safeNum(document.getElementById('upphDailyUPPH').textContent || '0'),
                dailyRate: safeNum((document.getElementById('upphDailyRate').textContent || '0%').replace('%', '')),
                monthOutput: safeNum(document.getElementById('upphMonthO').value),
                monthHr: safeNum(document.getElementById('upphMonthH').value),
                monthUPPH: safeNum(document.getElementById('upphMonthUPPH').textContent || '0'),
                monthRate: safeNum((document.getElementById('upphMonthRate').textContent || '0%').replace('%', ''))
            };

            // 自动计算月度累计(当月之前所有日期的累计)
            if (db.prodReport) {
                var monthTotalOutput = 0;
                var monthTotalHours = 0;

                // 计算当月所有日期的累计
                Object.keys(db.prodReport).forEach(function(dayDate) {
                    if (dayDate.startsWith(currentMonth) && dayDate <= date) {
                        var dayData = db.prodReport[dayDate];
                        if (dayData.upph) {
                            monthTotalOutput += safeNum(dayData.upph.dailyOutput) || 0;
                            monthTotalHours += safeNum(dayData.upph.dailyHr) || 0;
                        }
                    }
                });

                // 更新月度累计值
                data.upph.monthOutput = monthTotalOutput;
                data.upph.monthHr = monthTotalHours;

                // 更新月度UPPH和提升率
                var baseline = safeNum(document.getElementById('upphBaseline').value);
                var mUPPH = monthTotalHours > 0 ? (monthTotalOutput / monthTotalHours) : 0;
                var mRate = baseline > 0 ? ((mUPPH - baseline) / baseline * 100) : 0;
                data.upph.monthUPPH = mUPPH;
                data.upph.monthRate = mRate;

                // 更新页面显示
                document.getElementById('upphMonthO').value = monthTotalOutput;
                document.getElementById('upphMonthH').value = monthTotalHours;
                document.getElementById('upphMonthUPPH').textContent = mUPPH.toFixed(2);
                document.getElementById('upphMonthRate').textContent = mRate.toFixed(2) + '%';
            };
            // Read notes
            data.notes = document.getElementById('prodNotes').value;

            // 自动计算班次月度累计
            if (db.prodReport) {
                // 初始化月度累计数据
                var monthlyShiftData = {};

                // 计算当月所有日期的班次累计
                Object.keys(db.prodReport).forEach(function(dayDate) {
                    if (dayDate.startsWith(currentMonth) && dayDate <= date) {
                        var dayData = db.prodReport[dayDate];
                        if (dayData.shifts && dayData.shifts.length > 0) {
                            dayData.shifts.forEach(function(shift) {
                                var key = shift.line + '_' + shift.shift;
                                if (!monthlyShiftData[key]) {
                                    monthlyShiftData[key] = {
                                        line: shift.line,
                                        shift: shift.shift,
                                        mTarget: 0,
                                        mActual: 0
                                    };
                                }
                                monthlyShiftData[key].mTarget += safeNum(shift.target) || 0;
                                monthlyShiftData[key].mActual += safeNum(shift.actual) || 0;
                            });
                        }
                    }
                });

                // 更新当前日期的班次月度累计数据
                data.shifts.forEach(function(shift, idx) {
                    var key = shift.line + '_' + shift.shift;
                    if (monthlyShiftData[key]) {
                        data.shifts[idx].mTarget = monthlyShiftData[key].mTarget;
                        data.shifts[idx].mActual = monthlyShiftData[key].mActual;
                        data.shifts[idx].mRate = monthlyShiftData[key].mTarget > 0 ?
                            (monthlyShiftData[key].mActual / monthlyShiftData[key].mTarget * 100).toFixed(2) : 0;
                    }
                });
            }

            triggerAutoSave();
        };
        function renderDM() {
            var _tbody = document.getElementById('dmCheckBody'); if(!_tbody) return;
            const date = window.safeDOM.val("globalDate"); const dmData = ensureDMData(date); const tbody = _tbody; let htmlStr = '';
            // 只渲染车间,不包含HFS和曲轴生产线
            const workshopsOnly = ['PRO1', 'PRO2', 'PRO3', 'PRO4'];
            workshopsOnly.forEach(ws => {
                if(!dmData[ws]) dmData[ws] = {am:0,pm:0};
                htmlStr += `<tr><td style="font-weight:800; color:var(--midea-dark);">${ws}</td><td><input type="checkbox" style="width:16px;height:16px;cursor:pointer; accent-color:var(--midea-blue);" ${dmData[ws].am?'checked':''} onchange="db.dm['${date}']['${ws}'].am=this.checked?1:0; triggerAutoSave(); renderDMRate();"></td><td><input type="checkbox" style="width:16px;height:16px;cursor:pointer; accent-color:var(--midea-blue);" ${dmData[ws].pm?'checked':''} onchange="db.dm['${date}']['${ws}'].pm=this.checked?1:0; triggerAutoSave(); renderDMRate();"></td></tr>`;
            });
            tbody.innerHTML = htmlStr; if(typeof renderDMRate==='function') try{renderDMRate()}catch(e){}
        }
        window.renderDMRate = function() {
            var _tbody = document.getElementById('dmRateBody'); if(!_tbody) return;
            const tbody = _tbody;
            const elAgg = document.getElementById('dmAggType'); if(!elAgg) { tbody.innerHTML=''; return; }
            const type = elAgg.value; let dates = Object.keys(db.dm||{}).sort();
            if(type === 'week') dates = dates.slice(-7); else if(type === 'month') dates = dates.filter(d => d.startsWith(window.safeDOM.val("globalDate").substring(0,7)));
            if(dates.length === 0) { tbody.innerHTML=''; return; }
            // 只包含车间,不包括HFS和曲轴生产线
            let stats = { 'PRO1':{t:0,a:0}, 'PRO2':{t:0,a:0}, 'PRO3':{t:0,a:0}, 'PRO4':{t:0,a:0} };
            dates.forEach(d => {
                Object.keys(stats).forEach(ws => {
                    if(db.dm[d] && db.dm[d][ws]) {
                        stats[ws].t += 2;
                        stats[ws].a += (db.dm[d][ws].am + db.dm[d][ws].pm);
                    }
                });
            });
            let list = Object.keys(stats).map(ws => ({ ws, t:stats[ws].t, a:stats[ws].a, r: stats[ws].t>0 ? (stats[ws].a/stats[ws].t*100).toFixed(0) : 0 })).sort((a,b) => b.r - a.r);
            let htmlStr = ''; list.forEach((r, i) => { htmlStr += `<tr><td><b style="color:var(--midea-blue);">${i+1}</b></td><td style="color:var(--midea-dark); font-weight:800;">${r.ws}</td><td>${r.t}</td><td>${r.a}</td><td class="${r.r==100?'val-success':'val-danger'}">${r.r}%</td></tr>`; });
            tbody.innerHTML = htmlStr;
        }
        // ★ 性能优化:防抖版 filter render
        var _renderPDCATimer = null;
        window._debouncedRenderPDCA = function() {
            if (_renderPDCATimer) clearTimeout(_renderPDCATimer);
            _renderPDCATimer = setTimeout(function() {
                _renderPDCATimer = null;
                window.renderPDCA();
            }, 150);
        };
        // ★ 短日期格式转换:YYYY-MM-DD → M/D,用于缩窄列宽
        window.toShortDate = function(dateStr) {
            if (!dateStr) return '';
            var parts = dateStr.split('-');
            if (parts.length < 3) return dateStr;
            return parseInt(parts[1]) + '/' + parseInt(parts[2]);
        };
        // ★ 反转换:M/D → YYYY-MM-DD(补全年份)
        window.fromShortDate = function(shortStr) {
            if (!shortStr) return '';
            if (shortStr.indexOf('-') > 0 && shortStr.length > 7) return shortStr; // 已经是完整格式
            var parts = shortStr.split('/');
            if (parts.length < 2) return shortStr;
            var today = new Date();
            var year = today.getFullYear();
            var m = parseInt(parts[0]);
            var d = parseInt(parts[1]);
            if (m < 1 || m > 12 || d < 1 || d > 31) return shortStr;
            return year + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
        };
        window.renderPDCA = function() {
            const fDate = document.getElementById('f-date').value; const fWs = document.getElementById('f-ws').value; const fDesc = document.getElementById('f-desc').value.toLowerCase(); const fLoc = document.getElementById('f-loc').value.toLowerCase(); const fOwner = document.getElementById('f-owner').value.toLowerCase(); const fDept = document.getElementById('f-dept').value; const fDuedate = document.getElementById('f-duedate').value; const fStatus = document.getElementById('f-status').value;
            const fAStart = document.getElementById('psp-ai-start').value; const fAEnd = document.getElementById('psp-ai-end').value;
            const tbody = document.getElementById('pdcaBody'); 
            let list = db.problems.filter(p => {
                let statStr = fStatus; if(currentLang==='en') { if(statStr==='未解决') statStr='Open'; if(statStr==='处理中') statStr='In Prog'; if(statStr==='已解决') statStr='Closed'; } else if(currentLang==='th') { if(statStr==='未解决') statStr='ยังไม่แก้'; if(statStr==='处理中') statStr='กำลังทำ'; if(statStr==='已解决') statStr='แก้ไขแล้ว'; }
                return (!fDate || p.date === fDate) && (!fWs || p.ws === fWs) && (!fDept || p.dept === fDept) && (!fDuedate || p.dueDate === fDuedate) && (!fStatus || p.status === fStatus || p.status === statStr) && (!fDesc || String(p.desc).toLowerCase().includes(fDesc)) && (!fLoc || String(p.loc).toLowerCase().includes(fLoc)) && (!fOwner || String(p.owner).toLowerCase().includes(fOwner)) && (!fAStart || p.date >= fAStart) && (!fAEnd || p.date <= fAEnd);
            });
            let htmlStr = '';
            list.forEach(p => {
                let sColor = 'var(--danger)'; let sVal = p.status; if(sVal==='已解决' || sVal==='Closed' || sVal==='แก้ไขแล้ว') sColor='var(--success)'; else if(sVal==='处理中' || sVal==='In Prog' || sVal==='กําลังทํา') sColor='var(--warning)';
                let deptOptionsHtml = DEPTS.map(d => `<option ${p.dept===d?'selected':''}>${d}</option>`).join('');
                var shortDate = window.toShortDate(p.date);
                var shortDue = window.toShortDate(p.dueDate);
                htmlStr += `<tr><td><input type="text" value="${shortDate}" onchange="updateProb('${p.id}','date',window.fromShortDate(this.value))" style="width:100%;"></td><td><select onchange="updateProb('${p.id}','ws',this.value)"><option ${p.ws=='PRO1'?'selected':''}>PRO1</option><option ${p.ws=='PRO2'?'selected':''}>PRO2</option><option ${p.ws=='PRO3'?'selected':''}>PRO3</option><option ${p.ws=='PRO4'?'selected':''}>PRO4</option></select></td><td style="min-width:200px;"><input type="text" class="text-left" value="${translateUserText(p.desc||'')}" onchange="updateProb('${p.id}','desc',this.value)" style="width:100%;"></td><td><input type="text" value="${p.loc||''}" placeholder="线体/班次" onchange="updateProb('${p.id}','loc',this.value)" style="width:100%;"></td><td><input type="text" value="${p.owner}" onchange="updateProb('${p.id}','owner',this.value)" style="width:100%;"></td><td><select onchange="updateProb('${p.id}','dept',this.value)">${deptOptionsHtml}</select></td><td><input type="text" value="${shortDue}" onchange="updateProb('${p.id}','dueDate',window.fromShortDate(this.value))" style="font-size:12px;width:100%;box-sizing:border-box;"></td><td><select onchange="updateProb('${p.id}','status',this.value)" style="color:${sColor}; font-weight:800;"><option value="未解决" ${sVal==='未解决'||sVal==='Open'||sVal==='ยังไม่แก้'?'selected':''}>${t('status_unres')}</option><option value="处理中" ${sVal==='处理中'||sVal==='In Prog'||sVal==='กําลังทํา'?'selected':''}>${t('status_prog')}</option><option value="已解决" ${sVal==='已解决'||sVal==='Closed'||sVal==='แก้ไขแล้ว'?'selected':''}>${t('status_res')}</option></select></td><td><button style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:15px;" onclick="delProb('${p.id}')"><i class="fa-solid fa-trash-can"></i></button></td></tr>`;
            });
            tbody.innerHTML = htmlStr;
        }
        window.addProblem = function() { db.problems.unshift({ id:Date.now(), date:window.safeDOM.val("globalDate"), ws:'PRO1', desc:'', loc:'', owner:'', dept:'PE', dueDate:'', status: (currentLang==='zh'?'未解决':(currentLang==='en'?'Open':'ยังไม่แก้')) }); triggerAutoSave(); renderPDCA(); renderSysOps(); };
        window.updateProb = function(id, f, v) { let p = db.problems.find(x=>x.id==id); if(p) { p[f]=v; } triggerAutoSave(); renderSysOps(); };
        window.delProb = function(id) { db.problems = db.problems.filter(x=>x.id!=id); _deferredLocalStorageSave(); setTimeout(function(){ if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else { triggerAutoSave(); } }, 0); renderPDCA(); renderSysOps(); };
        // ★ 性能优化：防抖版 filter render，避免快速输入时频繁重绘
        var _renderLossTimer = null;
        window._debouncedRenderLoss = function() {
            if (_renderLossTimer) clearTimeout(_renderLossTimer);
            _renderLossTimer = setTimeout(function() {
                _renderLossTimer = null;
                window.renderLoss();
            }, 150);
        };
        window.renderLoss = function() {
            const fDate = document.getElementById('fl-date').value; const fLine = document.getElementById('fl-line').value; const fShift = document.getElementById('fl-shift').value; const fDesc = document.getElementById('fl-desc').value.toLowerCase(); const fOwner = document.getElementById('fl-owner').value.toLowerCase(); const fDept = document.getElementById('fl-dept').value;
            const fAStart = document.getElementById('loss-ai-start').value; const fAEnd = document.getElementById('loss-ai-end').value;
            const tbody = document.getElementById('lossBody');
            let list = (db.loss || []).filter(p => { return (!fDate || p.date === fDate) && (!fLine || p.line === fLine) && (!fShift || p.shift === fShift) && (!fDept || p.dept === fDept) && (!fDesc || String(p.desc||'').toLowerCase().includes(fDesc)) && (!fOwner || String(p.owner||'').toLowerCase().includes(fOwner)) && (!fAStart || p.date >= fAStart) && (!fAEnd || p.date <= fAEnd); });
            let htmlStr = '';
            list.forEach(p => {
                let deptOptionsHtml = DEPTS.map(d => `<option ${p.dept===d?'selected':''}>${d}</option>`).join('');
                // PSP/事中关联状态
                let pspInfo = '<div style="position:relative;display:inline-block;">';
                if(p.pspId || p.midId) {
                    pspInfo += `<button class="loss-psp-plus linked" data-loss-id="${p.id}" onclick="toggleLossLink(this)" title="已关联(点击修改)" style="border:none;background:none;cursor:pointer;padding:2px 6px;"><i class="fa-solid fa-plus" style="color:var(--danger);font-size:18px;font-weight:900;"></i></button>`;
                } else {
pspInfo += `<button class="loss-psp-plus" data-loss-id="${p.id}" onclick="toggleLossLink(this)" title="点击关联" style="border:none;background:none;cursor:pointer;padding:2px 6px;"><i class="fa-solid fa-plus" style="color:var(--midea-blue);font-size:14px;"></i></button>`;
                }
                htmlStr += `<tr><td style="text-align:center;"><input type="checkbox" class="loss-checkbox" data-id="${p.id}" onchange="window.handleLossCheckboxChange(this)"></td><td><input type="date" value="${p.date}" onchange="updateLoss('${p.id}','date',this.value)"></td><td><select onchange="updateLoss('${p.id}','line',this.value)"><option value="LINE A" ${p.line=='LINE A'?'selected':''}>LINE A</option><option value="LINE B" ${p.line=='LINE B'?'selected':''}>LINE B</option><option value="LINE C" ${p.line=='LINE C'?'selected':''}>LINE C</option><option value="LINE D" ${p.line=='LINE D'?'selected':''}>LINE D</option></select></td><td><select onchange="updateLoss('${p.id}','shift',this.value)"><option value="D" ${p.shift=='D'?'selected':''}>D (白班)</option><option value="N" ${p.shift=='N'?'selected':''}>N (夜班)</option></select></td><td class="col-desc"><input type="text" class="text-left" value="${translateUserText(p.desc||'')}" onchange="updateLoss('${p.id}','desc',this.value)" style="font-size:13px;"></td><td><input type="number" class="${p.qty<0?'val-danger':''}" value="${p.qty}" onchange="updateLoss('${p.id}','qty',this.value)"></td><td><input type="text" value="${p.owner}" onchange="updateLoss('${p.id}','owner',this.value)"></td><td><select onchange="updateLoss('${p.id}','dept',this.value)">${deptOptionsHtml}</select></td><td style="text-align:center;">${pspInfo}</div></td><td><button style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:15px;" onclick="delLoss('${p.id}')"><i class="fa-solid fa-trash-can"></i></button></td></tr>`;
            });
            tbody.innerHTML = htmlStr;
        }
        window.addLossRecord = function() { if(!db.loss) db.loss = []; db.loss.unshift({ id:Date.now(), date:window.safeDOM.val("globalDate"), line:'LINE A', shift:'D', desc:'', qty:0, owner:'', dept:'PE', pspId:null, midId:null }); triggerAutoSave(); checkRepeatLoss(); renderLoss(); renderSysOps(); }
        window.updateLoss = function(id, f, v) { let p = db.loss.find(x=>x.id==id); if(p) { p[f] = f==='qty'?safeNum(v):v; } triggerAutoSave(); renderSysOps(); }
        // ★ 修复:delLoss 必须 await forceSaveToFirebase,否则保存失败时用户不知情,数据在几秒后从云端恢复
        window.delLoss = function(id) {
            db.loss = db.loss.filter(x=>x.id!=id);
            // ★ 性能优化:延迟保存 localStorage,不阻塞 UI 渲染
            _deferredLocalStorageSave();
            // ★ 性能优化:延迟 forceSaveToFirebase 到下一 macrotask,避免 repairData+sanitize 阻塞 UI
            setTimeout(function(){
                if (typeof forceSaveToFirebase === 'function') {
                    forceSaveToFirebase().then(function(saved){
                        if (!saved) {
                            console.warn('[delLoss] 删除后异步保存失败,数据可能恢复');
                        }
                    }).catch(function(err){
                        console.error('[delLoss] 删除后异步保存异常:', err);
                    });
                } else {
                    triggerAutoSave();
                }
            }, 0);
            renderLoss();
            renderSysOps();
        }
        // ================= 📦 LOSS 多选批量删除功能 =================
        window.selectedLossIds = new Set();
        // 获取当前筛选条件下的所有LOSS记录ID
        function getFilteredLossIds() {
            const fDate = document.getElementById('fl-date').value;
            const fLine = document.getElementById('fl-line').value;
            const fShift = document.getElementById('fl-shift').value;
            const fDesc = document.getElementById('fl-desc').value.toLowerCase();
            const fOwner = document.getElementById('fl-owner').value.toLowerCase();
            const fDept = document.getElementById('fl-dept').value;

            return (db.loss || [])
                .filter(p => {
                    return (!fDate || p.date === fDate) &&
                           (!fLine || p.line === fLine) &&
                           (!fShift || p.shift === fShift) &&
                           (!fDept || p.dept === fDept) &&
                           (!fDesc || String(p.desc||'').toLowerCase().includes(fDesc)) &&
                           (!fOwner || String(p.owner||'').toLowerCase().includes(fOwner));
                })
                .map(p => p.id);
        }

        window.updateLossSelection = function() {
            selectedLossIds.clear();
            const checkedBoxes = document.querySelectorAll('.loss-checkbox:checked');

            checkedBoxes.forEach(cb => {
                const id = parseInt(cb.getAttribute('data-id'));
                if (!isNaN(id)) {
                    selectedLossIds.add(id);
                }
            });

            // 更新全选复选框状态
            let totalCheckboxes = document.querySelectorAll('.loss-checkbox').length;
            let checkedCheckboxes = checkedBoxes.length;
            let selectAllCheckbox = document.getElementById('loss-select-all');
            if (selectAllCheckbox) {
                selectAllCheckbox.checked = totalCheckboxes > 0 && checkedCheckboxes === totalCheckboxes;
                selectAllCheckbox.indeterminate = checkedCheckboxes > 0 && checkedCheckboxes < totalCheckboxes;
            }
        };
        window.toggleSelectAllLoss = function(checkbox) {
            const isChecked = checkbox.checked;
            const checkboxes = document.querySelectorAll('.loss-checkbox');

            // 先清空选中集合
            selectedLossIds.clear();

            // 更新所有复选框的显示状态
            checkboxes.forEach(cb => {
                cb.checked = isChecked;
            });

            // 如果是选中,获取当前筛选条件下的所有记录ID
            if (isChecked) {
                const filteredIds = getFilteredLossIds();
                filteredIds.forEach(id => {
                    selectedLossIds.add(id);
                });
            }

            // 更新全选复选框UI状态
            const selectAllCheckbox = document.getElementById('loss-select-all');
            if (selectAllCheckbox) {
                selectAllCheckbox.checked = isChecked;
                selectAllCheckbox.indeterminate = false;
            }
        };
        window.handleLossCheckboxChange = function(checkbox) {
            console.log('handleLossCheckboxChange: 复选框改变,checked:', checkbox.checked, 'data-id:', checkbox.getAttribute('data-id'));
            const id = parseInt(checkbox.getAttribute('data-id'));
            if (!isNaN(id)) {
                if (checkbox.checked) {
                    selectedLossIds.add(id);
                } else {
                    selectedLossIds.delete(id);
                }
            }
            // 更新全选复选框状态
            window.updateLossSelection();
        };
        window.selectAllLoss = function() {
            const selectAllCheckbox = document.getElementById('loss-select-all');
            if (!selectAllCheckbox) return;
            const newState = !selectAllCheckbox.checked;
            selectAllCheckbox.checked = newState;
            window.toggleSelectAllLoss(selectAllCheckbox);
        };
        window.batchDeleteLoss = async function() {
            if (selectedLossIds.size === 0) {
                showToast('fa-solid fa-info-circle', '请先选择要删除的LOSS记录', 'warning');
                return;
            }
            let deleteCount = selectedLossIds.size;
            if (!confirm(`确定要批量删除选中的 ${deleteCount} 条LOSS记录吗?此操作不可撤销。`)) {
                return;
            }

            // 记录删除前的数据状态(用于调试)
            console.log('删除前LOSS记录数:', db.loss.length);

            // 删除选中的记录 - 使用更可靠的方法
            let newLossArray = [];
            for(let i = 0; i < db.loss.length; i++) {
                if(!selectedLossIds.has(db.loss[i].id)) {
                    newLossArray.push(db.loss[i]);
                }
            }

            // 直接替换数组,避免引用问题
            db.loss = newLossArray;

            // 立即更新全局数据库引用
            if(window.db) window.db.loss = db.loss;

            console.log('删除后LOSS记录数:', db.loss.length);

            // 清空选择
            selectedLossIds.clear();

            // 立即更新UI,但不触发自动保存(避免重新加载)
            renderLoss();

            // ★ 立即强制保存(跳过防抖)+ 本地配额处理,防止云端旧缓存恢复已删数据
            var saveOk = true;
            try {
                localStorage.setItem(DB_KEY, JSON.stringify(db));
            } catch(lsErr) {
                console.warn('[batchDelete] localStorage写入失败,移除备份后重试');
                try { localStorage.removeItem(DB_KEY + '_backup'); } catch(ex) {}
                try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch(e2) {
                    console.error('[batchDelete] localStorage写入仍然失败', e2.message);
                }
            }
            if (typeof forceSaveToFirebase === 'function') {
                for (var retry = 0; retry < 3; retry++) {
                    if (await forceSaveToFirebase()) {
                        saveOk = true;
                        break;
                    }
                    console.warn('[batchDelete] 强制保存失败,重试第 ' + (retry+1) + ' 次...');
                    await new Promise(function(r) { setTimeout(r, 500); });
                }
            } else {
                // fallback
                if (isFirebaseReady) {
                    for (var retry2 = 0; retry2 < 3; retry2++) {
                        if (await saveToFirebase()) {
                            saveOk = true;
                            break;
                        }
                        await new Promise(function(r) { setTimeout(r, 500); });
                    }
                }
            }
            if (!saveOk) {
                showToast('fa-solid fa-exclamation-triangle', '⚠️ 云端保存失败,请检查网络后重试删除操作', 'error');
            }
            if(typeof renderSysOps === 'function') renderSysOps();
        };
        // ================= 📤 LOSS 导出到Excel =================
        window.exportLossToExcel = function() {
            var lossData = db.loss || [];
            if (lossData.length === 0) {
                showToast('fa-solid fa-info-circle', '没有LOSS记录可导出', 'warning');
                return;
            }
            try {
                // 按日期降序排列(最新的在前),与页面展示顺序一致
                var sorted = lossData.slice().sort(function(a, b) { return (b.date||'').localeCompare(a.date||''); });
                var xlsData = sorted.map(function(r, idx) {
                    return {
                        '序号': idx + 1,
                        '日期': r.date || '',
                        '线体': r.line || '',
                        '班次': r.shift === 'D' ? 'D (白班)' : r.shift === 'N' ? 'N (夜班)' : '',
                        '异常问题点描述': r.desc || '',
                        '损失数量': r.qty || 0,
                        '责任人': r.owner || '',
                        '责任部门': r.dept || ''
                    };
                });
                var wb = XLSX.utils.book_new();
                var ws = XLSX.utils.json_to_sheet(xlsData);
                ws['!cols'] = [
                    { wch: 6 },
                    { wch: 12 },
                    { wch: 10 },
                    { wch: 12 },
                    { wch: 60 },
                    { wch: 10 },
                    { wch: 12 },
                    { wch: 12 }
                ];
                XLSX.utils.book_append_sheet(wb, ws, 'LOSS记录');
                var fileName = 'LOSS管控导出_' + new Date().toISOString().slice(0, 10) + '.xlsx';
                XLSX.writeFile(wb, fileName);
                showToast('fa-solid fa-check', '已导出 ' + xlsData.length + ' 条LOSS记录');
            } catch(e) {
                console.error('[导出LOSS失败]', e);
                showToast('fa-solid fa-xmark', '导出失败: ' + e.message, 'error');
            }
        };
        // ================= 📋 PSP 导出Excel（按日期筛选范围） =================
        // ★ PSP 问题点闭环通报（新窗口打开 + 逾期高亮 + 中英双语）
        window.generatePSPCompactReport = function() {
            try {
                var startInput = document.getElementById('psp-ai-start');
                var endInput = document.getElementById('psp-ai-end');
                if (!startInput || !endInput) {
                    showToast('fa-solid fa-exclamation-triangle', '找不到日期选择器', 'error');
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
                var problems = (db.problems || []).filter(function(p) { return p.date >= start && p.date <= end; });
                if (problems.length === 0) {
                    showToast('fa-solid fa-info-circle', '所选时间段内暂无异常问题记录');
                    return;
                }

                // 统计
                var totalP = problems.length;
                var solved = 0, inProg = 0, open = 0;
                var todayStr = new Date().toISOString().split('T')[0];
                var overdueCount = 0;

                problems.forEach(function(p) {
                    var st = p.status || '未解决';
                    if (st === '已解决' || st === 'Closed' || st === 'แก้ไขแล้ว') solved++;
                    else if (st === '处理中' || st === 'In Prog' || st === 'กําลังทํา') inProg++;
                    else open++;
                    if (p.dueDate && (st === '未解决' || st === 'Open' || st === 'ยังไม่แก้' || st === '处理中' || st === 'In Prog' || st === 'กําลังทํา')) {
                        if (p.dueDate < todayStr) overdueCount++;
                    }
                });

                var closeRate = totalP > 0 ? ((solved / totalP) * 100).toFixed(1) : '0.0';

                // 构建海报HTML
                var h = '<div class="psp-poster">';

                // 标题
                h += '<div class="psp-poster-hdr">';
                h += '<div class="psp-poster-title">\uD83D\uDCE2 异常问题闭环通报<div class="bi-en-title">PSP Problem Close-Out Report</div></div>';
                h += '<div class="psp-poster-period">\u7EDF\u8BA1\u5468\u671F: ' + start + '  ~  ' + end + '&emsp;|&emsp;生成时间: ' + new Date().toLocaleString('zh-CN', {hour12:false}) + '<br><span class="bi-en-sub">Period: ' + start + ' ~ ' + end + ' | Generated: ' + new Date().toLocaleString('en-US', {hour12:false}) + '</span></div>';
                h += '</div>';

                // 顶部概要条
                h += '<div class="psp-poster-summary-bar">';
                h += '<div class="psp-ps-item"><b>' + totalP + '</b><span class="bi-cn">问题总数</span><span class="bi-en">Total Problems</span></div>';
                h += '<div class="psp-ps-item"><b style="color:#16a34a;">' + closeRate + '%</b><span class="bi-cn">闭环率</span><span class="bi-en">Close Rate</span></div>';
                h += '<div class="psp-ps-item"><b style="color:#dc2626;">' + open + '</b><span class="bi-cn">未解决</span><span class="bi-en">Open</span></div>';
                h += '<div class="psp-ps-item"><b style="color:#ea580c;">' + inProg + '</b><span class="bi-cn">处理中</span><span class="bi-en">In Progress</span></div>';
                h += '<div class="psp-ps-item"><b style="color:#16a34a;">' + solved + '</b><span class="bi-cn">已解决</span><span class="bi-en">Closed</span></div>';
                h += '<div class="psp-ps-item" style="background:#fef2f2;"><b style="color:#dc2626;font-size:22px;">' + overdueCount + '</b><span class="bi-cn" style="color:#dc2626;">已逾期</span><span class="bi-en" style="color:#dc2626;">Overdue</span></div>';
                h += '</div>';

                // 表格
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

                // 排序: 逾期优先 → 未解决 → 处理中 → 已解决
                problems.sort(function(a, b) {
                    var aOv = (a.dueDate && a.dueDate < todayStr && a.status !== '已解决' && a.status !== 'Closed' && a.status !== 'แก้ไขแล้ว') ? 1 : 0;
                    var bOv = (b.dueDate && b.dueDate < todayStr && b.status !== '已解决' && b.status !== 'Closed' && b.status !== 'แก้ไขแล้ว') ? 1 : 0;
                    if (aOv !== bOv) return bOv - aOv;
                    var aS = a.status === '已解决' || a.status === 'Closed' || a.status === 'แก้ไขแล้ว' ? 2 : (a.status === '处理中' || a.status === 'In Prog' || a.status === 'กําลังทํา' ? 1 : 0);
                    var bS = b.status === '已解决' || b.status === 'Closed' || b.status === 'แก้ไขแล้ว' ? 2 : (b.status === '处理中' || b.status === 'In Prog' || b.status === 'กําลังทํา' ? 1 : 0);
                    return aS - bS;
                });

                for (var i = 0; i < problems.length; i++) {
                    var p = problems[i];
                    var st = p.status || '未解决';
                    var isSolved = (st === '已解决' || st === 'Closed' || st === 'แก้ไขแล้ว');
                    var isOverdue = (p.dueDate && !isSolved && p.dueDate < todayStr);
                    var rowBg = isOverdue ? 'background:#fef2f2;' : '';
                    var statusStyle = isSolved ? 'color:#16a34a;font-weight:800;' : (st === '处理中' || st === 'In Prog' || st === 'กําลังทํา' ? 'color:#ea580c;font-weight:800;' : 'color:#dc2626;font-weight:800;');
                    var statusGlow = isSolved ? 'text-shadow:0 0 8px rgba(22,163,74,0.6);' : (st === '处理中' || st === 'In Prog' || st === 'กําลังทํา' ? 'text-shadow:0 0 8px rgba(234,88,12,0.5);' : 'text-shadow:0 0 8px rgba(220,38,38,0.5);');
                    var statusCN = (isSolved ? '已解决' : (st === '处理中' || st === 'In Prog' || st === 'กําลังทํา' ? '处理中' : '未解决'));
                    var statusEN = (isSolved ? 'Closed' : (st === '处理中' || st === 'In Prog' || st === 'กําลังทํา' ? 'In Progress' : 'Open'));

                    h += '<tr style="' + rowBg + '">';
                    h += '<td>' + (p.date || '') + '</td>';
                    h += '<td>' + (p.ws || '') + '</td>';
                    h += '<td style="text-align:left;word-break:break-word;font-size:13px;line-height:1.5;padding:5px 8px;">' + (p.desc || '') + '</td>';
                    h += '<td>' + (p.dept || '') + '</td>';
                    h += '<td>' + (p.owner || '') + '</td>';
                    h += '<td>' + (p.dueDate || '') + '</td>';
                    h += '<td style="font-size:13px;font-weight:900;' + statusStyle + statusGlow + '"><span class="bi-cn" style="font-size:13px;font-weight:900;">' + statusCN + '</span><span class="bi-en" style="font-size:10px;font-weight:600;">' + statusEN + '</span></td>';
                    h += '<td>' + (isOverdue ? '<div style="background:#dc2626;color:#fff;font-weight:900;font-size:15px;padding:3px 8px;border-radius:4px;text-align:center;"><span class="bi-cn">\u26A0\uFE0F 已逾期</span><br><span class="bi-en" style="color:#fff;font-size:10px;">Overdue</span></div>' : '') + '</td>';
                    h += '</tr>';
                }

                h += '</tbody></table>';

                // 脚注
                h += '<div class="psp-poster-footer">';
                h += '逾期说明:纳期已过但状态仍未关闭的问题标记为红色「已逾期」,请责任部门尽快确认并处理。<br>';
                h += '<span class="bi-en-foot">Note: Items past due date and not yet closed are marked in red as "Overdue". Please confirm and take action ASAP.</span>';
                h += '</div>';

                h += '</div>'; // psp-poster

                // 打开新窗口
                var win = window.open('', '_blank');
                if (!win) {
                    showToast('fa-solid fa-warning', '请允许弹窗以导出海报', 'error');
                    return;
                }

                // 收集页面样式
                var styleHTML = '';
                var styles = document.querySelectorAll('style, link[rel="stylesheet"]');
                for (var si = 0; si < styles.length; si++) {
                    styleHTML += styles[si].outerHTML;
                }

                win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PSP异常问题闭环通报 | PSP Problem Close-Out Report</title>');
                win.document.write(styleHTML);
                win.document.write('<style>' +
                    'body{margin:0;padding:8px;background:#f8fafc;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:12px;}' +
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

                showToast('fa-solid fa-file-image', '已生成PSP通报,可在新窗口打印/另存为PDF');
                setTimeout(function() {
                    win.focus();
                    win.print();
                }, 500);

            } catch(e) {
                console.error('[PSP海报] 生成失败:', e.message, e.stack);
                showToast('fa-solid fa-xmark', '海报生成失败: ' + e.message, 'error');
            }
        };

        window.exportPSPToExcel = function() {
            var fAStart = document.getElementById('psp-ai-start').value;
            var fAEnd = document.getElementById('psp-ai-end').value;
            var filtered = db.problems.filter(function(p) {
                return (!fAStart || p.date >= fAStart) && (!fAEnd || p.date <= fAEnd);
            });
            if (filtered.length === 0) {
                showToast('fa-solid fa-info-circle', '所选日期范围内没有PSP记录', 'warning');
                return;
            }
            try {
                var sorted = filtered.slice().sort(function(a, b) { return (b.date||'').localeCompare(a.date||''); });
                var xlsData = sorted.map(function(r, idx) {
                    var statusText = r.status || '';
                    return {
                        '序号': idx + 1,
                        '日期': r.date || '',
                        '车间': r.ws || '',
                        '问题详细描述': r.desc || '',
                        '线体/班次': r.loc || '',
                        '跟进人': r.owner || '',
                        '责任部门': r.dept || '',
                        '纳期': r.dueDate || '',
                        '状态': statusText
                    };
                });
                var wb = XLSX.utils.book_new();
                var ws = XLSX.utils.json_to_sheet(xlsData);
                ws['!cols'] = [
                    { wch: 6 },
                    { wch: 12 },
                    { wch: 8 },
                    { wch: 60 },
                    { wch: 12 },
                    { wch: 10 },
                    { wch: 12 },
                    { wch: 12 },
                    { wch: 10 }
                ];
                XLSX.utils.book_append_sheet(wb, ws, 'PSP记录');
                var fileName = 'PSP闭环导出_' + new Date().toISOString().slice(0, 10) + '.xlsx';
                XLSX.writeFile(wb, fileName);
                showToast('fa-solid fa-check', '已导出 ' + xlsData.length + ' 条PSP记录');
            } catch(e) {
                console.error('[导出PSP失败]', e);
                showToast('fa-solid fa-xmark', '导出失败: ' + e.message, 'error');
            }
        };
        // ================= 📋 事前/事中/事后 导出Excel =================
        window.exportSysDetailExcel = function() {
            var month = (document.getElementById('sys-detail-month')||{}).value || window.safeDOM.val("globalDate").substring(0, 7);
            var typeLabel = { pre:'事前', mid:'事中', post:'事后', equipment:'设备点检' };
            var label = typeLabel[currentSysDetailType] || '系统运作';
            var rows = sysDetailRows().filter(function(r) { return String(r.date||'').startsWith(month); });
            if (currentSysDetailType === 'post') {
                // 事后特殊处理：分开导出DM打卡和改善项目
                var dmRows = rows.filter(function(r) { return r.type === 'dm_punch'; });
                var impRows = rows.filter(function(r) { return r.type === 'improvement'; });
                var xlsData = [];
                dmRows.forEach(function(r) {
                    xlsData.push({ '类型':'DM打卡', '日期':r.date||'', '已完成':r.dmDone?'✓':'—' });
                });
                impRows.forEach(function(r) {
                    xlsData.push({ '类型':'改善项目', '日期':r.date||'', '项目名称':r.projectName||'', '目标':r.target||'', '进展':r.progress||'' });
                });
                if (xlsData.length === 0) { showToast('fa-solid fa-info-circle', '本月暂无事后数据', 'warning'); return; }
                try {
                    var wb = XLSX.utils.book_new();
                    var ws = XLSX.utils.json_to_sheet(xlsData);
                    ws['!cols'] = [
                        { wch: 10 },
                        { wch: 14 },
                        { wch: 10 },
                        { wch: 30 },
                        { wch: 20 },
                        { wch: 20 }
                    ];
                    XLSX.utils.book_append_sheet(wb, ws, '事后数据');
                    var fileName = '事后导出_' + month + '.xlsx';
                    XLSX.writeFile(wb, fileName);
                    showToast('fa-solid fa-check', '已导出 ' + xlsData.length + ' 条事后记录');
                } catch(e) {
                    console.error('[导出事后失败]', e);
                    showToast('fa-solid fa-xmark', '导出失败: ' + e.message, 'error');
                }
                return;
            }
            if (currentSysDetailType === 'equipment') {
                // 设备点检导出
                if (!rows.length) { showToast('fa-solid fa-info-circle', '本月无设备点检记录', 'warning'); return; }
                try {
                    var xlsData = rows.map(function(r) {
                        return {
                            '日期': r.date || '',
                            '点检位置': r.checkPlace || '',
                            '车间': r.ws || '',
                            '责任部门': r.dept || '',
                            '已打卡': r.checked ? '✓' : '—',
                            '备注': r.notes || ''
                        };
                    });
                    var wb = XLSX.utils.book_new();
                    var ws = XLSX.utils.json_to_sheet(xlsData);
                    ws['!cols'] = [
                        { wch: 14 },
                        { wch: 20 },
                        { wch: 10 },
                        { wch: 16 },
                        { wch: 10 },
                        { wch: 30 }
                    ];
                    XLSX.utils.book_append_sheet(wb, ws, '设备点检');
                    var fileName = '设备点检导出_' + month + '.xlsx';
                    XLSX.writeFile(wb, fileName);
                    showToast('fa-solid fa-check', '已导出 ' + xlsData.length + ' 条设备点检记录');
                } catch(e) {
                    console.error('[导出设备点检失败]', e);
                    showToast('fa-solid fa-xmark', '导出失败: ' + e.message, 'error');
                }
                return;
            }
            if (!rows.length) {
                showToast('fa-solid fa-info-circle', '本月暂无' + label + '记录', 'warning');
                return;
            }
            try {
                var xlsData, cols;
                if (currentSysDetailType === 'pre') {
                    xlsData = rows.map(function(r) {
                        return {
                            '日期': r.date || '',
                            '车间': r.ws || '',
                            '责任归属': r.ownerDept || '',
                            '线体/设备': r.equipment || r.line || '',
                            '检查项目': r.item || '',
                            '异常说明': r.issue || '',
                            '责任人': r.resp || '',
                            '状态': r.status || ''
                        };
                    });
                    cols = [
                        { wch: 14 },
                        { wch: 10 },
                        { wch: 12 },
                        { wch: 20 },
                        { wch: 20 },
                        { wch: 30 },
                        { wch: 12 },
                        { wch: 10 }
                    ];
                } else {
                    // mid 事中
                    xlsData = rows.map(function(r) {
                        return {
                            '日期': r.date || '',
                            '车间': r.ws || '',
                            '线体': r.line || '',
                            '事件': r.event || '',
                            '响应(分)': r.responseMin || 0,
                            '停机时长(分)': r.waitMin || 0,
                            '影响数量(台)': r.impactQty || 0,
                            '责任人': r.resp || ''
                        };
                    });
                    cols = [
                        { wch: 14 },
                        { wch: 10 },
                        { wch: 10 },
                        { wch: 40 },
                        { wch: 12 },
                        { wch: 12 },
                        { wch: 14 },
                        { wch: 12 }
                    ];
                }
                var wb = XLSX.utils.book_new();
                var ws = XLSX.utils.json_to_sheet(xlsData);
                ws['!cols'] = cols;
                XLSX.utils.book_append_sheet(wb, ws, label + '记录');
                var fileName = label + '导出_' + month + '.xlsx';
                XLSX.writeFile(wb, fileName);
                showToast('fa-solid fa-check', '已导出 ' + xlsData.length + ' 条' + label + '记录');
            } catch(e) {
                console.error('[导出' + label + '失败]', e);
                showToast('fa-solid fa-xmark', '导出失败: ' + e.message, 'error');
            }
        };
        // ================= 🔗 LOSS ↔ PSP 关联功能 =================
        let _currentLossIdForLink = null;
        window.showLossLinkModal = function(btnOrId) {
            var lossId = (btnOrId && btnOrId.dataset) ? btnOrId.dataset.lossId : btnOrId;
            _currentLossIdForLink = lossId;
            document.querySelectorAll('.loss-psp-plus.active').forEach(function(el) { el.classList.remove('active'); });
            if (btnOrId && btnOrId.classList) btnOrId.classList.add('active');
            let loss = db.loss.find(x => x.id == lossId);
            if(!loss) return;
            document.getElementById('lossLinkDesc').innerText = (loss.desc||'').substring(0,50) + ((loss.desc||'').length>50?'...':'');
            document.getElementById('lossLinkDate').innerText = '📅 ' + loss.date + ' ' + loss.line + ' ' + loss.shift;
            let wsMatch = { 'LINE A':'PRO1','LINE B':'PRO2','LINE C':'PRO3','LINE D':'PRO4' }[loss.line] || 'PRO2';
            let candidates = db.problems.filter(x => x.ws === wsMatch && (x.status==='未解决'||x.status==='Open'||x.status==='ยังไม่แก้'||x.status==='处理中'||x.status==='In Prog'||x.status==='กําลังทํา'));
            let listHtml = '';
            if(candidates.length === 0) {
                listHtml = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-weight:700;">暂无符合条件的 PSP,请「一键生成新 PSP」</div>';
            } else {
                candidates.forEach(psp => {
                    let isSelected = (psp.id == loss.pspId);
                    let pspStatus = psp.status;
                    let sc = (pspStatus==='已解决'||pspStatus==='Closed'||pspStatus==='แก้ไขแล้ว') ? 'closed' : 'open';
                    listHtml += `<div class="loss-psp-option ${isSelected?'selected':''}" onclick="linkLossToPsp('${psp.id}')">`;
                    listHtml += `<span><strong>${(psp.desc||'').substring(0,40)}</strong><br><span style="font-size:10px;color:var(--text-muted);">${psp.date} | ${psp.owner} | ${psp.dept}</span></span>`;
                    listHtml += `<span class="lpo-status ${sc}">${psp.status}</span>`;
                    listHtml += `</div>`;
                });
            }
            document.getElementById('lossLinkPSPList').innerHTML = listHtml;
            document.getElementById('lossLinkModal').style.display = 'flex';
        };
        var _currentLossLinkId = null;
        window.toggleLossLink = function(btn) {
            var lossId = btn.dataset.lossId;
            var loss = db.loss.find(function(x) { return x.id == lossId; });
            if(!loss) return;
            _currentLossLinkId = lossId;
            document.querySelectorAll('.loss-link-dd').forEach(function(d){ d.style.display='none'; });
            var dd = document.getElementById('lossLinkDropdown');
            var items = [];
            if(loss.pspId) {
                var psp = db.problems.find(function(p){ return p.id == loss.pspId; });
                items.push({ icon:'fa-link', label:'已关联PSP: '+(psp?psp.desc?.slice(0,20)||'#'+String(loss.pspId).slice(-4):'#'+String(loss.pspId).slice(-4)), action:'unlinkPsp' });
            } else {
                items.push({ icon:'fa-exclamation-circle', label:'关联异常问题闭环(PSP)', action:'linkPsp' });
            }
            if(loss.midId) {
                items.push({ icon:'fa-clock', label:'已关联事中响应', action:'unlinkMid' });
            } else {
                items.push({ icon:'fa-gauge-high', label:'关联事中响应', action:'linkMid' });
            }
            dd.innerHTML = items.map(function(it){
                return '<div class="loss-link-dd-item" data-action="'+it.action+'" onclick="execLossLinkAction(\''+it.action+'\')"><i class="fa-solid '+it.icon+'"></i> '+it.label+'</div>';
            }).join('') + '<div class="loss-link-dd-item" data-action="cancel" onclick="closeLossLinkDD()" style="border-top:1px solid var(--border-light);color:var(--text-muted);font-weight:500;"><i class="fa-solid fa-xmark"></i> 取消</div>';
            var rect = btn.getBoundingClientRect();
            dd.style.position = 'fixed';
            dd.style.top = (rect.bottom + 4) + 'px';
            dd.style.left = Math.max(4, rect.left - 80) + 'px';
            dd.style.display = 'block';
        };
        window.closeLossLinkDD = function() {
            document.getElementById('lossLinkDropdown').style.display = 'none';
        };
        window.execLossLinkAction = function(action) {
            var loss = db.loss.find(function(x) { return x.id == _currentLossLinkId; });
            if(!loss) return closeLossLinkDD();
            closeLossLinkDD();
            if(action === 'linkPsp') {
                var wsMatch = { 'LINE A':'PRO1','LINE B':'PRO2','LINE C':'PRO3','LINE D':'PRO4' }[loss.line] || 'PRO2';
                var newPsp = { id:Date.now(), date:loss.date, ws:wsMatch, desc:loss.desc, loc:loss.line+'/'+loss.shift, owner:loss.owner, dept:loss.dept, status:'未解决' };
                db.problems.unshift(newPsp);
                loss.pspId = newPsp.id;
                triggerAutoSave(); renderLoss(); renderPDCA();
                showToast('fa-solid fa-check-circle', '✅ 已生成 PSP 并关联', 'success');
            } else if(action === 'unlinkPsp') {
                loss.pspId = null;
                triggerAutoSave(); renderLoss(); renderPDCA();
                showToast('fa-solid fa-unlink', '已取消PSP关联', 'warning');
            } else if(action === 'linkMid') {
                var wsMatch = { 'LINE A':'PRO1','LINE B':'PRO2','LINE C':'PRO3','LINE D':'PRO4' }[loss.line] || 'PRO2';
                if(!db.sysDetail) db.sysDetail = { mid: [] };
                if(!db.sysDetail.mid) db.sysDetail.mid = [];
                // ★ 修复Bug2:从LOSS链接到事中自动计算停机时长(420台/时=7台/分)
                var _impactQty = Math.abs(parseInt(loss.qty)||0);
                var _waitMin = Math.round(_impactQty / 7);
                var newMid = {
                    id: Date.now() + Math.random(),
                    date: loss.date,
                    ws: wsMatch,
                    line: loss.line,
                    event: 'LOSS: '+loss.desc + (loss.shift?' ('+loss.shift+')':''),
                    responseMin: 0,
                    waitMin: _waitMin,
                    impactQty: _impactQty,
                    patrol: '',
                    action: '',
                    resp: loss.owner || '',
                    status: '处理中'
                };
                db.sysDetail.mid.unshift(newMid);
                loss.midId = newMid.id;
                triggerAutoSave(); renderLoss(); renderSysOps();
                showToast('fa-solid fa-check-circle', '✅ 已创建事中响应记录并关联', 'success');
            } else if(action === 'unlinkMid') {
                loss.midId = null;
                triggerAutoSave(); renderLoss(); renderSysOps();
                showToast('fa-solid fa-unlink', '已取消事中关联', 'warning');
            }
        };
        document.addEventListener('click', function(e) {
            if(!e.target.closest('.loss-link-dd') && !e.target.closest('.loss-psp-plus')) {
                document.getElementById('lossLinkDropdown').style.display = 'none';
            }
        });
        window.linkLossToPsp = function(pspId) {
            let loss = db.loss.find(x => x.id == _currentLossIdForLink);
            if(!loss) return;
            loss.pspId = pspId;
            triggerAutoSave();
            renderLoss();
            renderPDCA();
            showToast('fa-solid fa-link', '已关联到 PSP #' + String(pspId).slice(-4), 'success');
            document.getElementById('lossLinkModal').style.display = 'none';
        };
        window.createPSPfromLoss = function() {
            let loss = db.loss.find(x => x.id == _currentLossIdForLink);
            if(!loss) return;
            let wsMatch = { 'LINE A':'PRO1','LINE B':'PRO2','LINE C':'PRO3','LINE D':'PRO4' }[loss.line] || 'PRO2';
            let newPsp = { id:Date.now(), date:loss.date, ws:wsMatch, desc:loss.desc, loc:loss.line+'/'+loss.shift, owner:loss.owner, dept:loss.dept, status:'未解决' };
            db.problems.unshift(newPsp);
            loss.pspId = newPsp.id;
            triggerAutoSave();
            renderLoss();
            renderPDCA();
            showToast('fa-solid fa-check-circle', '✅ 已从 LOSS 生成 PSP 并自动关联', 'success');
            document.getElementById('lossLinkModal').style.display = 'none';
        };
        window.unlinkLossPsp = function() {
            let loss = db.loss.find(x => x.id == _currentLossIdForLink);
            if(!loss) return;
            loss.pspId = null;
            triggerAutoSave();
            renderLoss();
            renderPDCA();
            showToast('fa-solid fa-unlink', '已取消关联', 'warning');
            document.getElementById('lossLinkModal').style.display = 'none';
        };
        window.checkRepeatLoss = function() {
            let lossList = db.loss || [];
            if(lossList.length < 2) return;
            let last = lossList[0];
            if(!last.desc) return;
            let repeat = lossList.slice(1).filter(x => {
                if(!x.desc) return false;
                let daysDiff = Math.abs((new Date(x.date) - new Date(last.date)) / 86400000);
                return daysDiff <= 3 && x.desc.toLowerCase() === last.desc.toLowerCase() && x.line === last.line;
            });
            if(repeat.length > 0) {
                let rHtml = '<div style="color:var(--danger); font-weight:700; margin-bottom:8px;">以下 LOSS 在3天内重复出现:</div>';
                repeat.forEach(r => {
                    let linked = r.pspId ? '已关联' : '未关联';
                    rHtml += `<div style="padding:8px; border:1px solid var(--border); border-radius:6px; margin-bottom:6px;"><strong>${r.date}</strong> ${r.line} ${r.shift} - ${r.desc} (${r.qty}) [${linked}]</div>`;
                });
                rHtml += '<div style="color:var(--warning); font-size:12px; margin-top:8px;">💡 建议:检查根因对策是否有效,如需生成 PSP 请关联!</div>';
                document.getElementById('repeatLossList').innerHTML = rHtml;
                document.getElementById('repeatLossModal').style.display = 'flex';
            }
        };
        window.updateProb = (function(orig) {
            return function(id, f, v) {
                orig(id, f, v);
                if(f === 'status') {
                    let psp = db.problems.find(x => x.id == id);
                    if(psp && (psp.status==='已解决'||psp.status==='Closed'||psp.status==='แก้ไขแล้ว')) {
                        let linkedLossCount = (db.loss||[]).filter(x => x.pspId == id).length;
                        if(linkedLossCount > 0) {
                            showToast('fa-solid fa-check-double', `PSP已解决,已关联 ${linkedLossCount} 个LOSS`);
                        }
                    }
                }
            };
        })(window.updateProb);
        // ================= 少人化年度追踪 (独立页面版) =================
        var kzChart = null;
        function renderKzTrend() {
            var klist = db.kaizen || [];
            var months = []; var monthData = {};
            klist.forEach(function(r) {
                var d = r.startDate || r.date || '';
                if(!d) return;
                var m = d.substring(0,7);
                if(!months.includes(m)) months.push(m);
                if(!monthData[m]) monthData[m] = { saved:0, count:0 };
                monthData[m].saved += safeNum(r.saved);
                if(r.status === '已完成') monthData[m].count++;
            });
            months.sort();
            if(months.length === 0) { months = ['2026-01','2026-02','2026-03','2026-04','2026-05']; months.forEach(function(m){ monthData[m]={saved:0,count:0}; }); }
            var labels = months.map(function(m){ return m.substring(5)+'月'; });
            var savedData = months.map(function(m){ return monthData[m].saved; });
            var targetData = months.map(function(){ return 8; });
            var ctx = document.getElementById('kzTrendChart');
            if(!ctx) return;
            if(kzChart) kzChart.destroy();
            if(typeof Chart === 'undefined') return;
            kzChart = new Chart(ctx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        { label:'月度减人数', data:savedData, backgroundColor:'#10b981', borderRadius:4 },
                        { label:'月度目标(~8人)', data:targetData, backgroundColor:'rgba(148,163,184,0.3)', borderColor:'#94a3b8', borderWidth:2, borderDash:[4,3], borderRadius:4, type:'bar' }
                    ]
                },
                options: {
                    responsive:true, maintainAspectRatio:false,
                    plugins: { legend:{ position:'top', labels:{font:{weight:'bold',size:11}} } },
                    scales: { y:{ beginAtZero:true, grid:{color:'rgba(0,163,224,0.05)'} }, x:{ grid:{display:false} } }
                }
            });
        }
        window.openKaizenPaste = function() {
            document.getElementById('kaizenPasteInput').value = '';
            document.getElementById('kaizen-paste-modal').style.display = 'flex';
        };
        window.parseKaizenPaste = function() {
            var raw = document.getElementById('kaizenPasteInput').value.trim();
            if(!raw) return showToast('fa-solid fa-triangle-exclamation', '请先粘贴项目内容', 'warning');
            if(!db.kaizen) db.kaizen = [];
            var lines = raw.split(/\r?\n/).filter(function(l){ return l.trim(); });
            var count = 0;
            lines.forEach(function(line){
                // 支持 Tab 或逗号分隔
                var cols = line.includes('\t') ? line.split('\t') : line.split(',');
                if(cols.length < 2) return;
                var project = cols[0].trim();
                if(!project) return;
                var ws = 'PRO2';
                var saved = 1;
                var status = '未开始';
                var owner = '';
                var completeDate = '';
                if(cols.length >= 2) ws = cols[1].trim().toUpperCase();
                if(cols.length >= 3) saved = parseFloat(cols[2].trim()) || 1;
                if(cols.length >= 4) {
                    var s = cols[3].trim();
                    if(['未开始','进行中','已完成'].indexOf(s) >= 0) status = s;
                }
                if(cols.length >= 5) owner = cols[4].trim();
                if(cols.length >= 6) completeDate = cols[5].trim();
                db.kaizen.unshift({ id:Date.now()+Math.random(), project:project, ws:ws, saved:saved, completeDate:completeDate, status:status, owner:owner });
                count++;
            });
            if(count > 0) {
                triggerAutoSave(); renderKaizen();
                document.getElementById('kaizen-paste-modal').style.display = 'none';
                showToast('fa-solid fa-bolt', '极速解析完成:成功导入 '+count+' 个项目');
            } else {
                showToast('fa-solid fa-xmark', '未能识别有效项目数据,请检查格式', 'warning');
            }
        };
        window.addKaizenRecord = function() {
            if(!db.kaizen) db.kaizen = [];
            var today = window.safeDOM.val("globalDate");
            db.kaizen.unshift({ id:Date.now()+Math.random(), project:'', ws:'PRO2', saved:1, completeDate:'', status:'未开始', owner:'' });
            triggerAutoSave(); renderKaizen();
            showToast('fa-solid fa-plus', '新项目已添加,请填写详细信息');
        };
        window.updateKaizen = function(id, f, v) {
            var r = (db.kaizen||[]).find(function(x){ return x.id==id; });
            if(r) { r[f] = (f==='saved'?safeNum(v):v); triggerAutoSave(); renderKaizen(); }
        };
        window.delKaizen = function(id) {
            if(!confirm('确定删除该项目?')) return;
            db.kaizen = (db.kaizen||[]).filter(function(x){ return x.id!=id; });
            _deferredLocalStorageSave();
            setTimeout(function(){
                if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else { triggerAutoSave(); }
            }, 0);
            renderKaizen();
        };
        window.exportKaizenTable = function() {
            var list = db.kaizen || [];
            if(list.length === 0) return showToast('fa-solid fa-info','暂无数据可导出');
            var ws_data = [['项目名称','责任车间/部门','减人数','完成时间','状态','责任人']];
            list.forEach(function(r){
                ws_data.push([r.project||'', r.ws||'', safeNum(r.saved), r.completeDate||'', r.status||'', r.owner||'']);
            });
            var wb = XLSX.utils.book_new();
            var ws = XLSX.utils.aoa_to_sheet(ws_data);
            XLSX.utils.book_append_sheet(wb, ws, '少人化项目');
            XLSX.writeFile(wb, '少人化项目追踪_'+window.safeDOM.val("globalDate")+'.xlsx');
            showToast('fa-solid fa-file-excel', '导出成功');
        };
        function renderKaizen() {
            var list = db.kaizen || [];
            // 筛选
            var kw = (document.getElementById('kz-filter-keyword')||{}).value||'';
            var fws = (document.getElementById('kz-filter-ws')||{}).value||'';
            var fst = (document.getElementById('kz-filter-status')||{}).value||'';
            var fmt = (document.getElementById('kz-filter-method')||{}).value||'';
            if(kw) { var lkw = kw.toLowerCase(); list = list.filter(function(r){ return (r.project||'').toLowerCase().includes(lkw) || (r.owner||'').toLowerCase().includes(lkw); }); }
            if(fws) list = list.filter(function(r){ return r.ws === fws; });
            if(fst) list = list.filter(function(r){ return r.status === fst; });
            if(fmt) list = list.filter(function(r){ return r.method === fmt; });
            // KPI 汇总 (使用全部数据)
            var allList = db.kaizen || [];
            var totalSaved = allList.reduce(function(s,r){ return s + safeNum(r.saved); }, 0);
            var totalProj = allList.length;
            var completed = allList.filter(function(r){ return r.status === '已完成'; }).length;
            var inProgress = allList.filter(function(r){ return r.status === '进行中'; }).length;
            // 年度达成率:只统计已完成的项目的减人数
            var completedSaved = allList.filter(function(r){ return r.status === '已完成'; }).reduce(function(s,r){ return s + safeNum(r.saved); }, 0);
            var rate = Math.min(completedSaved / 100 * 100, 100);
            safeSetText('kz-total-saved', totalSaved);
            safeSetText('kz-total-proj', totalProj);
            safeSetText('kz-completed', completed);
            safeSetText('kz-in-progress', inProgress);
            safeSetText('kz-rate', rate.toFixed(0) + '%');
            safeSetText('kz-progress-text', completedSaved + ' / 100 人 ('+rate.toFixed(0)+'%)');
            var barEl = document.getElementById('kz-progress-bar'); if(barEl) barEl.style.width = rate + '%';
            // 表格
            var tbody = document.getElementById('kaizenBody');
            if(!tbody) return;
            if(list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="padding:20px;color:var(--text-muted);font-weight:700;text-align:center;">'+((db.kaizen||[]).length===0?'暂无项目,点击「新增项目」开始':'无匹配筛选结果')+'</td></tr>';
                renderKzTrend(); return;
            }
            var html = '';
            var idx = 0;
            list.forEach(function(r){
                idx++;
                var statusColor = r.status==='已完成'?'var(--success)':(r.status==='进行中'?'var(--warning)':'var(--text-muted)');
                var statusOpts = ['未开始','进行中','已完成'].map(function(s){ return '<option'+(r.status===s?' selected':'')+'>'+s+'</option>'; }).join('');
                var wsOpts = DEPTS.map(function(d){ return '<option'+(r.ws===d?' selected':'')+'>'+d+'</option>'; }).join('');
                html += '<tr>' +
                    '<td style="font-weight:800;color:var(--text-muted);font-size:10px;">'+idx+'</td>' +
                    '<td><input type="text" value="'+(r.project||'')+'" onchange="updateKaizen('+r.id+',\'project\',this.value)" style="width:100%;border:none;text-align:left;padding-left:6px;font-size:12px;font-weight:700;background:transparent;" placeholder="输入项目名称..."></td>' +
                    '<td><select onchange="updateKaizen('+r.id+',\'ws\',this.value)" style="width:100%;border:none;font-weight:800;font-size:11px;background:transparent;">'+wsOpts+'</select></td>' +
                    '<td><input type="number" value="'+r.saved+'" onchange="updateKaizen('+r.id+',\'saved\',this.value)" style="width:100%;border:none;text-align:center;font-weight:900;font-size:14px;color:var(--success);background:transparent;"></td>' +
                    '<td><input type="date" value="'+(r.completeDate||'')+'" onchange="updateKaizen('+r.id+',\'completeDate\',this.value)" style="width:100%;border:none;text-align:center;font-size:11px;font-weight:600;background:transparent;"></td>' +
                    '<td><select onchange="updateKaizen('+r.id+',\'status\',this.value)" style="width:100%;border:none;font-weight:800;font-size:11px;color:'+statusColor+';background:transparent;">'+statusOpts+'</select></td>' +
                    '<td><input type="text" value="'+(r.owner||'')+'" onchange="updateKaizen('+r.id+',\'owner\',this.value)" style="width:100%;border:none;text-align:center;font-size:11px;font-weight:700;background:transparent;" placeholder="责任人"></td>' +
                    '<td><button onclick="delKaizen('+r.id+')" style="border:none;background:none;color:var(--danger);cursor:pointer;"><i class="fa-solid fa-trash-can"></i></button></td>' +
                '</tr>';
            });
            tbody.innerHTML = html;
            renderKzTrend();
        }
        function safeSetText(id, val) { var el = document.getElementById(id); if(el) el.innerText = val; }
        let chartTrnd = null;
        // 注册数据标签插件
        if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
            Chart.register(ChartDataLabels);
        }
        window.renderTrend = function() {
            let span = parseInt(document.getElementById('trendSpan').value);
            let metric = document.getElementById('trendMetric').value;
            let wsFilter = document.getElementById('trendWs') ? document.getElementById('trendWs').value : 'all';
            let selectedDate = window.safeDOM.val("globalDate");
            let dates = Object.keys(db.prod).filter(d => d <= selectedDate).sort();
            if(dates.length > span) dates = dates.slice(-span);
            if(dates.length === 0) { if(chartTrnd) chartTrnd.destroy(); return; }

            // 定义所有车间
            let allWs = ['PRO1', 'PRO2', 'PRO3', 'PRO4', 'H_MOTOR', 'F_MOTOR', 'S_MOTOR', 'CRANK'];
            let displayWs = wsFilter === 'all' ? ['PRO1', 'PRO2', 'PRO3', 'PRO4'] : [wsFilter];

            // 收集数据
            let ds = {};
            allWs.forEach(function(ws) { ds[ws] = []; });
            dates.forEach(function(d) {
                allWs.forEach(function(ws) {
                    let m = calcWsData(d, ws) || {};
                    let val = 0;
                    if(metric==='upph') val = m.upph || 0;
                    else if(metric==='o') val = m.output || 0;
                    else if(metric==='h') val = m.hours || 0;
                    else if(metric==='loss') val = m.loss || 0;
                    else if(metric==='attRate') val = m.head>0 ? parseFloat(((m.att || 0)/(m.head || 1)*100).toFixed(1)) : 0;
                    else if(metric==='head') val = m.head;
                    ds[ws].push(val === 0 ? null : val);
                });
            });

            function getTrendLine(dataArray) {
                let xSum=0, ySum=0, xxSum=0, xySum=0; let count = 0;
                for (let i = 0; i < dataArray.length; i++) { if (dataArray[i] !== null && dataArray[i] !== undefined) { xSum += i; ySum += dataArray[i]; xxSum += i * i; xySum += i * dataArray[i]; count++; } }
                if(count < 2) return dataArray.map(()=>null); let slope = (count * xySum - xSum * ySum) / (count * xxSum - xSum * xSum); let intercept = (ySum - slope * xSum) / count;
                return dataArray.map((_, i) => { let v = slope * i + intercept; return (v > 0 || metric==='loss') ? parseFloat(v.toFixed(2)) : null; });
            }
            if (typeof Chart !== 'undefined') {
                const ctx = document.getElementById('chartTrend').getContext('2d'); if(chartTrnd) chartTrnd.destroy();
                const config = (color) => ({ borderColor: color, backgroundColor: color, borderWidth:3, pointRadius:5, pointBackgroundColor:'white', pointBorderWidth: 2, tension:0.4, spanGaps: true });
                const trendConfig = (color) => ({ borderColor: color, borderWidth:2, borderDash: [5, 5], pointRadius: 0, fill: false, tension: 0, pointHitRadius: 0 });

                const wsColors = {
                    'PRO1': '#64748b',
                    'PRO2': '#00A3E0',
                    'PRO3': '#f59e0b',
                    'PRO4': '#e11d48',
                    'H_MOTOR': '#8b5cf6',
                    'F_MOTOR': '#06b6d4',
                    'S_MOTOR': '#10b981',
                    'CRANK': '#f97316'
                };

                let datasets = [];
                displayWs.forEach(function(ws) {
                    let color = wsColors[ws] || '#64748b';
                    let label = NEW_MOTOR_NAMES[ws] || ws;
                    datasets.push({ label: label, data: ds[ws], ...config(color) });
                    // 趋势线使用相同颜色但带透明度
                    datasets.push({ label: label + '_T', data: getTrendLine(ds[ws]), ...trendConfig(color) });
                });

                chartTrnd = new Chart(ctx, {
                    type: 'line', data: { labels: dates.map(d=>d.substring(5)), datasets: datasets },
                    options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 30, right: 15 } }, interaction: { mode:'index', intersect:false }, plugins:{ legend:{ position:'top', labels:{ boxWidth:12, usePointStyle:true, filter: function(item) { return !item.text.includes('_T'); } }, onClick: function(e, legendItem, legend) { const index = legendItem.datasetIndex; const ci = legend.chart; const isVisible = ci.isDatasetVisible(index); ci.setDatasetVisibility(index, !isVisible); if (ci.data.datasets[index + 1] && ci.data.datasets[index + 1].label.includes('_T')) { ci.setDatasetVisibility(index + 1, !isVisible); } ci.update(); } }, datalabels: { display: function(context) { return context.dataset.data[context.dataIndex] !== null && !context.dataset.label.includes('_T'); }, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 4, borderColor: (c) => c.dataset.borderColor, borderWidth: 1, color: (c) => c.dataset.borderColor, font: { weight: '700', size: 11 }, padding: { top: 2, bottom: 2, left: 4, right: 4 }, offset: 8, align: function(context) { const idx = context.dataIndex; const totalPoints = context.dataset.data.length; const datasets = context.chart.data.datasets.filter(ds => !ds.label.includes('_T')); const dsIdx = datasets.indexOf(context.dataset); if (totalPoints > 20) { return idx % 2 === 0 ? 'top' : 'bottom'; } const positions = ['top', 'top', 'bottom', 'bottom']; return positions[dsIdx % 4]; }, anchor: 'end', formatter: function(value) { if (value === null) return ''; if (metric === 'attRate') return value + '%'; if (metric === 'upph') return parseFloat(value).toFixed(2); if (value >= 1000) return (value / 1000).toFixed(1) + 'k'; return value; } } }, scales:{x:{grid:{display:false}},y:{grid:{color:'rgba(0,163,224,0.05)'}, grace: '20%'}} }
                });
            }
        }
        let rBarChart=null, rPieChart=null;
        window.renderReport = function() {
            let type = document.getElementById('reportType').value; let dateVal = window.safeDOM.val("globalDate"); let dates = [];
            if(type === 'day') { dates = [dateVal]; } else if(type === 'month') { dates = Object.keys(db.prod).filter(d => d.startsWith(dateVal.substring(0,7))); } else { dates = Object.keys(db.prod).sort().filter(d => d <= dateVal).slice(-7); }

            // 如果没有数据,显示默认数据
            if(dates.length === 0) {
                dates = [dateVal];
                // 初始化默认数据
                if(!db.prod[dateVal]) {
                    db.prod[dateVal] = {};
                    ['PRO1','PRO2','PRO3','PRO4'].forEach(ws => {
                        db.prod[dateVal][ws] = {o:0, t:0, h:0, att:0, head:0, o1:0, o2:0, o3:0};
                    });
                }
            }

            document.getElementById('r-period').innerText = type==='day'?dateVal:(type==='month'?dateVal.substring(0,7)+` ${t('opt_month')}`:`${t('opt_7d')}`);
            let totalO=0, totalH=0, totalL=0; let totalAtt=0, totalHead=0;
            let wsAgg = { 'PRO1':{o:0,t:0,h:0,att:0,head:0}, 'PRO2':{o:0,t:0,h:0,att:0,head:0}, 'PRO3':{o:0,t:0,h:0,att:0,head:0}, 'PRO4':{o:0,t:0,h:0,att:0,head:0} };
            dates.forEach(d => { PRO_ORDER.forEach(ws => { let m = calcWsData(d, ws); if(m) { if(ws === 'PRO2') { totalO+=m.output || 0; totalH+=m.hours || 0; totalL+=m.loss || 0; } totalAtt+=m.att || 0; totalHead+=m.head || 0; if(wsAgg[ws]){wsAgg[ws].o+=m.output||0;wsAgg[ws].t+=m.target||0;wsAgg[ws].h+=m.hours||0;wsAgg[ws].att+=m.att||0;wsAgg[ws].head+=m.head||0;} } }); });
            let avgUpph = totalH > 0 ? (totalO / totalH).toFixed(2) : '0.00'; let avgAttRate = totalHead > 0 ? (totalAtt / totalHead * 100).toFixed(1) : '0.0';
            let dmTotal=0, dmAct=0; let dmWs = {'PRO1':{t:0,a:0}, 'PRO2':{t:0,a:0}, 'PRO3':{t:0,a:0}, 'PRO4':{t:0,a:0}, 'H_MOTOR':{t:0,a:0}, 'F_MOTOR':{t:0,a:0}, 'S_MOTOR':{t:0,a:0}, 'CRANK':{t:0,a:0}};
            dates.forEach(d => { if(db.dm[d]) { PRO_ORDER.forEach(ws => { if(db.dm[d][ws]) { dmTotal+=2; dmAct+=(db.dm[d][ws].am+db.dm[d][ws].pm); dmWs[ws].t+=2; dmWs[ws].a+=(db.dm[d][ws].am+db.dm[d][ws].pm); }}); }});
            let dmRate = dmTotal>0 ? (dmAct/dmTotal*100).toFixed(0) : 0;
            let pTotal=0, pClosed=0; let pDept = {}; DEPTS.forEach(d => { pDept[d] = { t:0, c:0 }; });
            db.problems.forEach(p => { if(dates.includes(p.date)) { pTotal++; if(p.status==='已解决' || p.status==='Closed' || p.status==='แก้ไขแล้ว') pClosed++; let dpt = p.dept||p.department; if(pDept[dpt]) { pDept[dpt].t++; if(p.status==='已解决' || p.status==='Closed' || p.status==='แก้ไขแล้ว') pDept[dpt].c++; } } });
            document.getElementById('rp-out-tot').innerText = totalO.toLocaleString(); document.getElementById('rp-upph-tot').innerText = avgUpph; document.getElementById('rp-loss-tot').innerText = totalL; document.getElementById('rp-dm-tot').innerText = dmRate + '%'; document.getElementById('rp-att-tot').innerText = avgAttRate + '%';
            const fillList = (id, html) => document.getElementById(id).innerHTML = html; let outHtml='', upphHtml='', lossHtml='', dmHtml='', attHtml='';
            PRO_ORDER.forEach(ws => {
                if(!wsAgg[ws]) return; let wUpph = wsAgg[ws].h > 0 ? (wsAgg[ws].o / wsAgg[ws].h).toFixed(2) : '0.00'; let wLoss = wsAgg[ws].o < wsAgg[ws].t ? (wsAgg[ws].o - wsAgg[ws].t) : 0; let wAtt = wsAgg[ws].head > 0 ? (wsAgg[ws].att / wsAgg[ws].head * 100).toFixed(1) : '0.0';
                outHtml += `<div><span style="color:var(--midea-dark);">${ws}</span><b>${wsAgg[ws].o}</b></div>`; upphHtml += `<div><span style="color:var(--midea-dark);">${ws}</span><b class="${wUpph>=23?'val-success':'val-danger'}">${wUpph}</b></div>`;
                lossHtml += `<div><span style="color:var(--midea-dark);">${ws}</span><b class="${wLoss<0?'val-danger':''}">${wLoss===0?'0':wLoss}</b></div>`;
                let wDm = dmWs[ws].t>0 ? (dmWs[ws].a/dmWs[ws].t*100).toFixed(0) : 0; dmHtml += `<div><span style="color:var(--midea-dark);">${ws}</span><b class="${wDm==100?'val-success':'val-danger'}">${wDm}%</b></div>`;
                attHtml += `<div><span style="color:var(--midea-dark);">${ws}</span><b class="${wAtt>=95?'val-success':'val-danger'}">${wAtt}%</b></div>`;
            });
            fillList('rp-out-list', outHtml); fillList('rp-upph-list', upphHtml); fillList('rp-loss-list', lossHtml); fillList('rp-dm-list', dmHtml); fillList('rp-att-list', attHtml);
            let probHtml = '';
            DEPTS.forEach(dpt => { let tCount = pDept[dpt].t; let cCount = pDept[dpt].c; let rate = tCount > 0 ? (cCount / tCount * 100).toFixed(0) : 100; probHtml += `<div class="r-dept-card"><span>${dpt}</span><b class="${rate>=80?'val-success':'val-danger'}">${rate}%</b></div>`; });
            fillList('rp-prob-list', probHtml);
            const monthKey = dateVal.substring(0,7);
            const preRows = db.sysDetail?.pre?.filter(r => String(r.date||'').startsWith(monthKey)) || [];
            const midRows = db.sysDetail?.mid?.filter(r => String(r.date||'').startsWith(monthKey)) || [];
            const preOk = preRows.filter(r => safeNum(r.actual) >= safeNum(r.plan)).length;
            const avgResp = midRows.length ? (midRows.reduce((s,r)=>s+safeNum(r.responseMin),0)/midRows.length).toFixed(1) : '-';
            const waitImpact = midRows.reduce((s,r)=>s+Math.abs(safeNum(r.impactQty)),0);
            const sysClose = document.getElementById('sys-close-rate')?.innerText || '100%';
            const sysRepeat = document.getElementById('sys-repeat-rate')?.innerText || '0%';
            fillList('rp-sys-list', `
                <div class="r-dept-card"><span>事前记录</span><b>${preRows.length}</b></div>
                <div class="r-dept-card"><span>事前达成率</span><b class="${preRows.length && preOk/preRows.length < .95?'val-danger':'val-success'}">${preRows.length?(preOk/preRows.length*100).toFixed(1):100}%</b></div>
                <div class="r-dept-card"><span>事中记录</span><b>${midRows.length}</b></div>
                <div class="r-dept-card"><span>平均响应</span><b>${avgResp}${avgResp==='-'?'':'分'}</b></div>
                <div class="r-dept-card"><span>等待影响</span><b class="${waitImpact>0?'val-danger':'val-success'}">${waitImpact}</b></div>
                <div class="r-dept-card"><span>关闭/复发</span><b>${sysClose} / ${sysRepeat}</b></div>
            `);
            let rcs = document.getElementById('rank-curr-start'); let rce = document.getElementById('rank-curr-end'); let rps = document.getElementById('rank-prev-start'); let rpe = document.getElementById('rank-prev-end');
            if (!rce.value) { let dtObj = new Date(dateVal); rce.value = dateVal; let dtObjStart = new Date(dtObj); dtObjStart.setDate(dtObjStart.getDate() - 6); rcs.value = dtObjStart.toISOString().split('T')[0]; let prevObjEnd = new Date(dtObjStart); prevObjEnd.setDate(prevObjEnd.getDate() - 1); rpe.value = prevObjEnd.toISOString().split('T')[0]; let prevObjStart = new Date(prevObjEnd); prevObjStart.setDate(prevObjStart.getDate() - 6); rps.value = prevObjStart.toISOString().split('T')[0]; }
            let currS = rcs.value; let currE = rce.value; let prevS = rps.value; let prevE = rpe.value; let dLossCurr = {}; let dLossPrev = {}; DEPTS.forEach(d => { dLossCurr[d] = 0; dLossPrev[d] = 0; });
            (db.loss || []).forEach(l => { let qtyAbs = Math.abs(l.qty || 0); if (l.date >= currS && l.date <= currE && dLossCurr[l.dept] !== undefined) { dLossCurr[l.dept] += qtyAbs; } if (l.date >= prevS && l.date <= prevE && dLossPrev[l.dept] !== undefined) { dLossPrev[l.dept] += qtyAbs; } });
            let rankArray = DEPTS.map(d => ({ dept: d, curr: dLossCurr[d], prev: dLossPrev[d] })).filter(item => item.curr > 0 || item.prev > 0).sort((a, b) => b.curr - a.curr);
            let rankHtml = '';
            if(rankArray.length === 0) { rankHtml = `<tr><td colspan="6" style="color:var(--text-muted); height:40px;">所选时间段内暂无损失记录</td></tr>`; }
            else {
                rankArray.forEach((r, i) => {
                    let delta = r.curr - r.prev; let deltaSign = delta > 0 ? '+' : '';
                    let badgeHtml = delta > 0 ? `<span class="badge-deteriorate">🟥 恶化 (${deltaSign}${delta})</span>` : (delta < 0 ? `<span class="badge-improve">🟩 改善 (${deltaSign}${delta})</span>` : `<span style="color:var(--text-muted); font-size:11px; font-weight:700;">➖ 持平</span>`);
                    let rankNumStyle = i===0 ? 'background: #F59E0B; color:white; padding: 2px 8px; border-radius:4px;' : (i===1 ? 'background: #94a3b8; color:white; padding: 2px 8px; border-radius:4px;' : (i===2 ? 'background: #b91c1c; color:white; padding: 2px 8px; border-radius:4px;' : 'font-weight:bold; color:var(--text-muted);'));
                    rankHtml += `<tr><td><span style="${rankNumStyle}">${i+1}</span></td><td style="text-align: left; padding-left: 15px; font-weight:800; color:var(--midea-dark);">${r.dept}</td><td style="font-weight:900; color:${r.curr>0?'var(--danger)':'var(--text-main)'}">${r.curr}</td><td style="font-weight:600; color:var(--text-muted)">${r.prev}</td><td style="font-weight:800; color:${delta>0?'var(--danger)':(delta<0?'var(--success)':'var(--text-muted)')}">${deltaSign}${delta}</td><td>${badgeHtml}</td></tr>`;
                });
            }
            document.getElementById('rp-loss-rank-body').innerHTML = rankHtml;
            console.log('开始渲染报告图表...');
            console.log('Chart.js 状态:', typeof Chart !== 'undefined' ? '已加载' : '未加载');

            if (typeof Chart !== 'undefined') {
                try {
                    const ctxBar = document.getElementById('r-barChart');
                    console.log('柱状图容器:', ctxBar ? '找到' : '未找到');
                    if(ctxBar) {
                        console.log('柱状图容器尺寸:', ctxBar.clientWidth, 'x', ctxBar.clientHeight);
                        const ctxBar2d = ctxBar.getContext('2d');
                        console.log('Canvas上下文:', ctxBar2d ? '有效' : '无效');
                        if(rBarChart) rBarChart.destroy();
                        let wsData = Object.keys(wsAgg).map(ws => ({ ws, out:wsAgg[ws].o, tgt:wsAgg[ws].t }));
                        rBarChart = new Chart(ctxBar2d, {
                            type: 'bar',
                            data: {
                                labels: wsData.map(d=>d.ws),
                                datasets: [
                                    { label:t('act_label'), data: wsData.map(d=>d.out), backgroundColor: '#0062ff', borderRadius:6 },
                                    { label:t('tgt_label'), data: wsData.map(d=>d.tgt), backgroundColor: '#cbd5e1', borderRadius:6 }
                                ]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                layout: { padding: { top: 25 } },
                                plugins: {
                                    datalabels: {
                                        align: 'top',
                                        anchor: 'end',
                                        color: (c) => c.datasetIndex === 0 ? '#0062ff' : '#64748b',
                                        font: { weight: '900', size: 12 }
                                    }
                                },
                                scales:{
                                    y:{grace: '20%', grid:{color:'rgba(0,163,224,0.05)'}},
                                    x:{grid:{display:false}}
                                }
                            }
                        });
                    }
                } catch (barError) {
                    console.error('柱状图渲染错误:', barError);
                }

                try {
                    const ctxPie = document.getElementById('r-pieChart');
                    if(ctxPie) {
                        const ctxPie2d = ctxPie.getContext('2d');
                        if(rPieChart) rPieChart.destroy();
                        const auroraColors = ['#0f172a', '#1e3a8a', '#0284c7', '#38bdf8', '#7dd3fc', '#e2e8f0', '#94a3b8', '#475569', '#334155', '#0ea5e9', '#0369a1'];
                        let activeDepts = Object.keys(pDept).filter(k => pDept[k].t > 0);
                        let pLabels = activeDepts;
                        let pData = activeDepts.map(k => pDept[k].t);
                        let bgColors = pLabels.map(l => auroraColors[DEPTS.indexOf(l)] || '#cbd5e1');

                        rPieChart = new Chart(ctxPie2d, {
                            type: 'doughnut',
                            data: {
                                labels: pLabels.length?pLabels:['暂无数据'],
                                datasets: [{
                                    data: pLabels.length?pData:[100],
                                    backgroundColor: pLabels.length?bgColors:['rgba(0,163,224,0.2)'],
                                    borderWidth: 3,
                                    borderColor: '#fff',
                                    hoverOffset: 4
                                }]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                cutout: '65%',
                                layout: { padding: 20 },
                                plugins: {
                                    legend: {
                                        position: 'right',
                                        labels: {
                                            boxWidth: 12,
                                            usePointStyle: true,
                                            font: {size: 11, weight:'bold'}
                                        }
                                    },
                                    datalabels: {
                                        color: '#fff',
                                        font: { weight: '800', size: 12 },
                                        textShadowColor: 'rgba(0,0,0,0.5)',
                                        textShadowBlur: 4,
                                        formatter: (v, ctx) => {
                                            let sum=0;
                                            let dataArr=ctx.chart.data.datasets[0].data;
                                            dataArr.map(d=>{sum+=d});
                                            return sum > 0 ? (v*100/sum).toFixed(0)+'%' : '0%';
                                        }
                                    }
                                }
                            }
                        });
                    }
                } catch (pieError) {
                    console.error('饼图渲染错误:', pieError);
                }
            } else {
                console.warn('Chart.js 未加载,图表无法渲染');
                // 显示图表占位信息
                const barChartEl = document.getElementById('r-barChart');
                const pieChartEl = document.getElementById('r-pieChart');
                if(barChartEl) barChartEl.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;font-size:14px;"><i class="fa-solid fa-chart-bar"></i><br>图表库加载中...</div>';
                if(pieChartEl) pieChartEl.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b;font-size:14px;"><i class="fa-solid fa-chart-pie"></i><br>图表库加载中...</div>';
            }
            applyReportFilters();
        }
        window.applyReportFilters = function() {
            document.querySelectorAll('.report-toggle').forEach(cb => {
                const target = document.getElementById(cb.dataset.target);
                if(target) target.classList.toggle('report-section-hidden', !cb.checked);
            });
        };
        window.toggleAISummary = function() {
            const box = document.getElementById('ai-summary-content');
            const icon = document.getElementById('ai-toggle-icon');
            const collapsed = box.style.display === 'none';
            box.style.display = collapsed ? 'block' : 'none';
            icon.className = collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
        };
        window.exportMonitorPoster = function() {
            var monitorContent = document.getElementById('p-monitor');
            if (!monitorContent) return showToast('fa-solid fa-warning', '未找到看板内容');
            var win = window.open('', '_blank');
            if (!win) { showToast('fa-solid fa-warning', '请允许弹窗以导出海报'); return; }
            var styles = document.querySelectorAll('style, link[rel="stylesheet"]');
            var styleHTML = '';
            styles.forEach(function(s) { styleHTML += s.outerHTML; });
            win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>每日生产看板海报</title>');
            win.document.write(styleHTML);
            win.document.write('<style>' +
                'body{margin:0;padding:15px;background:var(--bg-base);font-size:12px;}' +
                '.viewport,.sidebar,#particles-js,#drop-zone,.global-topbar,.monitorTargetPanel{display:none!important;}' +
                '#p-monitor{display:flex!important;position:static!important;overflow:visible!important;width:100%!important;}' +
                '.page{display:none!important;}' +
                '@page{size:A4;margin:8mm;}' +
                '.table-wrap{overflow:visible!important;width:100%!important;}' +
                'table.grid{min-width:100%!important;width:100%!important;table-layout:auto!important;}' +
                '#upphTable,#shiftTable{table-layout:auto!important;width:100%!important;}' +
                '@media print{' +
                'body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
                '.table-wrap{overflow:visible!important;}' +
                'table.grid{min-width:100%!important;table-layout:auto!important;}' +
                '}' +
                '</style></head><body>');
            win.document.write(monitorContent.outerHTML);
            win.document.write('</body></html>');
            win.document.close();
            showToast('fa-solid fa-file-image', '已生成看板海报预览,请在打印窗口选择「另存为PDF」');
            setTimeout(function() {
                win.focus();
                win.print();
            }, 800);
        };
        window.exportReportPDF = function() {
            var reportContent = document.getElementById('reportCanvasBlock');
            if (!reportContent) return showToast('fa-solid fa-warning', '未找到报告内容');
            var win = window.open('', '_blank');
            if (!win) { showToast('fa-solid fa-warning', '请允许弹窗以导出PDF'); return; }
            var styles = document.querySelectorAll('style, link[rel="stylesheet"]');
            var styleHTML = '';
            styles.forEach(function(s) { styleHTML += s.outerHTML; });
            win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>JAT生产全景总结报告</title>');
            win.document.write(styleHTML);
            win.document.write('<style>body{margin:0;padding:20px;background:white;font-size:12px;}' +
                '.viewport,.sidebar{display:none;}.report-canvas{width:100%;max-width:1200px;margin:0 auto;}' +
                '.page{display:block!important;position:static!important;overflow:visible!important;}' +
                '@media print{@page{size:A4 landscape;margin:10mm;}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}' +
                '</style></head><body>');
            win.document.write(reportContent.innerHTML);
            win.document.write('</body></html>');
            win.document.close();
            showToast('fa-solid fa-file-pdf', '已生成报告预览,请在打印窗口选择「另存为PDF」');
            setTimeout(function() {
                win.focus();
                win.print();
            }, 500);
        };
        // ================= 撤销与重做 =================
        let undoStack = []; let redoStack = []; let globalSnapshot = null;
        document.addEventListener('focusin', (e) => { if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) { globalSnapshot = JSON.stringify(db); } });
        document.addEventListener('change', (e) => { if(e.target.type === 'file') return; if(globalSnapshot && globalSnapshot !== JSON.stringify(db)) { undoStack.push(globalSnapshot); if(undoStack.length > 30) undoStack.shift(); redoStack = []; globalSnapshot = JSON.stringify(db); updateHistoryUI(); } });
        function updateHistoryUI() { document.getElementById('btn-undo').disabled = undoStack.length === 0; document.getElementById('btn-redo').disabled = redoStack.length === 0; }
        window.performUndo = function() { if(undoStack.length > 0) { redoStack.push(JSON.stringify(db)); db = JSON.parse(undoStack.pop()); globalSnapshot = JSON.stringify(db); updateHistoryUI(); triggerAutoSave(); refreshAllViews(); showToast('fa-solid fa-rotate-left', '已撤销'); } }
        window.performRedo = function() { if(redoStack.length > 0) { undoStack.push(JSON.stringify(db)); db = JSON.parse(redoStack.pop()); globalSnapshot = JSON.stringify(db); updateHistoryUI(); triggerAutoSave(); refreshAllViews(); showToast('fa-solid fa-rotate-right', '已重做'); } }
        // 方向键支持
        document.addEventListener('keydown', function(e) {
            if(e.target.tagName === 'INPUT' && e.target.closest('.grid')) {
                let current = e.target; let td = current.closest('td'); let tr = current.closest('tr');
                if(!td || !tr) return;
                let inputs = Array.from(tr.closest('tbody').querySelectorAll('input:not([readonly])')); let index = inputs.indexOf(current);
                if(index === -1) return;
                if(e.key === 'ArrowDown' || e.key === 'Enter') {
                    e.preventDefault(); let nextRowTr = tr.nextElementSibling;
                    while(nextRowTr && !nextRowTr.querySelector('input:not([readonly])')) nextRowTr = nextRowTr.nextElementSibling;
                    if(nextRowTr) { let cIdx = Array.from(tr.children).indexOf(td); let nextInput = nextRowTr.children[cIdx]?.querySelector('input:not([readonly])'); if(nextInput) nextInput.focus(); }
                } else if(e.key === 'ArrowUp') {
                    e.preventDefault(); let prevRowTr = tr.previousElementSibling;
                    while(prevRowTr && !prevRowTr.querySelector('input:not([readonly])')) prevRowTr = prevRowTr.previousElementSibling;
                    if(prevRowTr) { let cIdx = Array.from(tr.children).indexOf(td); let prevInput = prevRowTr.children[cIdx]?.querySelector('input:not([readonly])'); if(prevInput) prevInput.focus(); }
                } else if(e.key === 'ArrowRight') {
                    if(current.selectionStart === current.value.length || current.type === 'number') { e.preventDefault(); if(index + 1 < inputs.length) inputs[index+1].focus(); }
                } else if(e.key === 'ArrowLeft') {
                    if(current.selectionStart === 0 || current.type === 'number') { e.preventDefault(); if(index - 1 >= 0) inputs[index-1].focus(); }
                }
            }
        });
        document.addEventListener('focusin', (e) => { if(e.target.tagName === 'INPUT' && (e.target.type === 'number' || e.target.closest('.grid'))) { try{e.target.select();}catch(err){} } });
        // 多语言字典
        const i18n = {
            zh: { sys_name: "日常管理", menu_input: "实况数据录入", menu_sys: "事前事中事后", menu_monitor: "每日生产看板", menu_dm: "异常问题闭环", menu_loss: "异常LOSS管控", menu_trend: "全景趋势分析", menu_target: "目标管理", menu_sim: "工时&人员推演", menu_report: "经营全景报告", date_today: "今天", date_yesterday: "昨天", date_this_month: "本月", status_checking: "引擎自检中...", status_online: "云端协同在线", status_offline: "单机防丢模式", global_date: "全局业务日期:", drop_hint: "松开鼠标 释放生产与出勤数据进行AI解析", input_title: "生产与人力底账录入", btn_import_prod: "选择文件导入", btn_paste: "极速/AI导入", paste_title: "数据极速/AI导入引擎", paste_sub: "直接在 Excel 或 CSV 中按 Ctrl+A 全选复制,然后粘贴。若表头规整请点【极速解析】;若散乱请点【AI排版】。", btn_ai_parse: "AI 智能排版解析", th_ws: "制造单元/线体", th_target: "计划排产", th_output: "实际产出", th_hrs: "投入工时(H)", th_att: "出勤人数", th_head: "绝对人数", dash_title: "产出效率达成情况", kpi_pro2_out: "PRO2 当日产出", kpi_pro2_loss: "PRO2 当日 LOSS", rank_title: "LOSS 排名", chart_title: "产出达成对比", dm_title1: "DM 会议打卡", dm_title2: "开展率排位", dm_th_am: "AM 会议", dm_th_pm: "PM 会议", dm_th_rank: "名次", dm_th_should: "应开", dm_th_actual: "实开", dm_th_rate: "达成率", prob_title: "异常问题点闭环 (PSP)", btn_add: "新增异常", prob_th_date: "日期", prob_th_ws: "车间", prob_th_desc: "问题详细描述", prob_th_loc: "线体/班次", prob_th_owner: "责任人", prob_th_dept: "责任部门", prob_th_status: "状态", prob_th_del: "删", btn_ai_trans: "智能翻译", loss_title: "生产过程异常LOSS管控 (仅限 PRO2)", btn_add_loss: "新增LOSS记录", btn_ai_import: "无格式AI识别导入", loss_th_date: "日期", loss_th_line: "线体", loss_th_shift: "班次", loss_th_desc: "异常问题点描述", loss_th_qty: "损失数量", loss_ai_title: "AI 智能识别 LOSS", loss_ai_sub: "粘贴文本即可自动抓取", trend_title: "全景趋势分析", trend_memo: "人工复盘备忘录", opt_upph: "UPPH 达成趋势", opt_o: "实际产出 趋势", opt_loss: "LOSS 欠产套数趋势", opt_h: "投入工时(H) 趋势", opt_attrate: "出勤率 趋势", opt_head: "绝对人数 趋势", btn_ai_trend: "AI 智能洞察数据", opt_7d: "近 7 天", opt_15d: "近 15 天", opt_30d: "近 30 天", opt_month: "本月", opt_all: "全", opt_rep_day: "日报", opt_rep_week: "周报", opt_rep_month: "月报", btn_print: "打印报告", rep_title: "GAT 生产经营全景总结报告", rep_period: "统计范围:", r_out: "总产出 (PRO2)", r_upph: "平均 UPPH (PRO2)", r_loss: "总损失 LOSS (PRO2)", r_att: "全厂出勤率", r_dm: "DM 开展率", r_prob: "全局闭环率", r_prob_depts: "各责任部门异常闭环率明细", r_chart1: "各车间产出达成对比", r_chart2: "异常责任部门分布", ai_summary_title: "AI 智能管理复盘总结", btn_gen_ai: "生成专业复盘报告", r_loss_rank: "各责任部门 LOSS 排名与改善监控", ws_label: "车间", act_label: "实际", tgt_label: "计划", status_unres: "未解决", status_prog: "处理中", status_res: "已解决", normal: "正常", add_line: "新增线体", prod_upph_title: "UPPH Achievement", prod_shift_title: "Output Achievement of Each Shift PRO2", prod_pic: "PIC", prod_baseline: "2025 Baseline", prod_daily: "Daily", prod_monthly: "Monthly Total", prod_output: "Output", prod_working_hr: "Working Hour", prod_upph: "UPPH", prod_imp_rate: "Improvement Rate", prod_line: "LINE", prod_shift: "Shift", prod_target: "Target", prod_actual: "Actual", prod_rate: "Rate", prod_rank_d: "Rank (日)", prod_rank_m: "Rank (月)", prod_del: "删", prod_ttl: "TTL", prod_notes_title: "重点异常影响 (Notes)", prod_add_row: "Add Row", prod_date: "日期筛选", loss_filter_period: "LOSS周期筛选:", loss_to: "至", btn_ai_summary: "AI智能总结", btn_generate_report: "生成LOSS通报", btn_psp_report: "问题点闭环通报", btn_undo_translate: "撤回翻译", btn_batch_delete: "批量删除选中", btn_export_excel: "导出Excel", btn_fast_parse: "极速标准解析 (1秒内)", btn_ai_messy_parse: "AI 杂乱排版提取 (备用)", btn_cancel: "取消", btn_force_close: "强制关闭", btn_ai_extract: "无格式智能提取", btn_quick_import: "极速解析导入", btn_add_record: "新增记录", btn_confirm_save: "确认保存", btn_close: "关闭", btn_compact: "紧凑", btn_comfortable: "舒适", btn_save_continue: "知道了，继续保存", btn_target_set: "目标设定", btn_setting_theme: "主题", btn_setting_density: "密度", label_month: "月份", label_dept: "车间/部门", label_record_count: "记录数量", label_completion_rate: "达成率/关闭率", label_risk_pending: "待跟进风险", label_image_preview: "图片预览", label_original_size: "原始大小", label_compressed: "压缩后", label_quality: "压缩质量", label_paste_ctrl_v: "Ctrl+V 粘贴图片", label_paste_hint: "截图或复制图片后按 Ctrl+V 即可粘贴", label_select_file: "选择文件", label_theme_color: "主题颜色", label_display_density: "显示密度", modal_title_ai_report: "专家级 AI 智能分析报告", modal_title_kaizen_import: "少人化项目极速导入", modal_title_equip_photo: "设备点检图片", modal_title_sys_detail: "事前事中事后明细", modal_title_settings: "页面设置", msg_system_prompt: "系统提示", msg_ready: "就绪", hint_settings_save: "设置会保存在本机浏览器，不影响云端业务数据。主题用于改善长时间管理复盘时的可读性。", improve_title: "改善项目跟踪", improve_btn_poster: "导出改善项目海报", improve_btn_excel: "导出Excel", improve_btn_add: "新增改善项目", improve_filter_label: "筛选：", improve_filter_dept: "责任部门", improve_filter_status: "进度", improve_filter_date: "立项时间", improve_filter_to: "至", improve_opt_all: "全部", improve_btn_month: "本月", improve_total: "项目总数", improve_done: "已完成", improve_prog: "进行中", improve_over: "已逾期", improve_rate: "完成率", improve_thead_date: "立项时间", improve_thead_name: "项目名称", improve_thead_dept: "责任部门", improve_thead_status: "进度", improve_thead_desc: "进度描述", improve_thead_plan: "计划完成时间", improve_thead_del: "删", improve_status_notstart: "未开始", improve_status_prog: "进行中", improve_status_done: "已完成", improve_status_over: "逾期", improve_empty: "暂无改善项目，点击「新增改善项目」开始录入", improve_placeholder_name: "请输入项目名称", improve_placeholder_desc: "进度描述", improve_opt_select: "请选择", improve_confirm_del: "确认删除该改善项目？", improve_del_done: "改善项目已删除", improve_add_done: "已新增改善项目，请填写详细信息", improve_not_found: "暂无改善项目记录" },
            en: { sys_name: "Daily Management", menu_input: "Input Data", menu_sys: "System Ops", menu_monitor: "Daily Dashboard", menu_dm: "PSP Loop", menu_loss: "Loss Control", menu_trend: "Trend Analysis", menu_target: "Target Mgmt", menu_sim: "Manpower Sim", menu_report: "Summary Report", date_today: "Today", date_yesterday: "Yesterday", date_this_month: "This Month", status_checking: "Checking...", status_online: "Cloud Online", status_offline: "Local Mode", global_date: "Global Date:", drop_hint: "Drop file", input_title: "Production & HR Input", btn_import_prod: "Import File", btn_paste: "Smart Paste", paste_title: "Smart Import Engine", paste_sub: "Paste Excel/CSV.", btn_ai_parse: "AI Smart Parse", th_ws: "Area / Line", th_target: "Target", th_output: "Output", th_hrs: "Hours (H)", th_att: "Attendance", th_head: "Headcount", dash_title: "Efficiency Dashboard", kpi_pro2_out: "PRO2 Output", kpi_pro2_loss: "PRO2 LOSS", rank_title: "LOSS Ranking", chart_title: "Output vs Target", dm_title1: "DM Meeting Check", dm_title2: "Execution Rate", dm_th_am: "AM Mtg", dm_th_pm: "PM Mtg", dm_th_rank: "Rank", dm_th_should: "Plan", dm_th_actual: "Actual", dm_th_rate: "Rate", prob_title: "PDCA Problem Loop", btn_add: "Add Prob", prob_th_date: "Date", prob_th_ws: "Area", prob_th_desc: "Description", prob_th_loc: "Line/Shift", prob_th_owner: "Owner", prob_th_dept: "Dept", prob_th_status: "Status", prob_th_del: "Del", btn_ai_trans: "Translate", loss_title: "Production LOSS Control (PRO2)", btn_add_loss: "Add LOSS", btn_ai_import: "AI Smart Import", loss_th_date: "Date", loss_th_line: "Line", loss_th_shift: "Shift", loss_th_desc: "Description", loss_th_qty: "LOSS Qty", loss_ai_title: "AI LOSS Extraction", loss_ai_sub: "Paste any text.", trend_title: "Panoramic Trend Analysis", trend_memo: "Daily Review Memo", opt_upph: "UPPH Trend", opt_o: "Output Trend", opt_loss: "LOSS Qty Trend", opt_h: "Hours Trend", opt_attrate: "Att. Rate Trend", opt_head: "Headcount Trend", btn_ai_trend: "AI Data Insight", opt_7d: "Last 7 Days", opt_15d: "Last 15 Days", opt_30d: "Last 30 Days", opt_month: "This Month", opt_all: "All", opt_rep_day: "Daily Report", opt_rep_week: "Weekly Report", opt_rep_month: "Monthly Report", btn_print: "Print Report", rep_title: "GAT Panoramic Summary Report", rep_period: "Period:", r_out: "Total Output (PRO2)", r_upph: "Avg UPPH (PRO2)", r_loss: "Total LOSS (PRO2)", r_att: "Avg Attendance", r_dm: "DM Exec Rate", r_prob: "Global Close Rate", r_prob_depts: "Dept Close Rate Details", r_chart1: "Output Comparison", r_chart2: "Problem Dept Dist", ai_summary_title: "AI Exec Summary", btn_gen_ai: "Generate Report", r_loss_rank: "Dept LOSS Ranking & Improvement", ws_label: "Area", act_label: "Actual", tgt_label: "Target", status_unres: "Open", status_prog: "In Prog", status_res: "Closed", normal: "Normal", add_line: "Add Line", prod_upph_title: "UPPH Achievement", prod_shift_title: "Output Achievement of Each Shift PRO2", prod_pic: "PIC", prod_baseline: "2025 Baseline", prod_daily: "Daily", prod_monthly: "Monthly Total", prod_output: "Output", prod_working_hr: "Work. Hour", prod_upph: "UPPH", prod_imp_rate: "Imp. Rate", prod_line: "LINE", prod_shift: "Shift", prod_target: "Target", prod_actual: "Actual", prod_rate: "Rate", prod_rank_d: "Rank (D)", prod_rank_m: "Rank (M)", prod_del: "Del", prod_ttl: "TTL", prod_notes_title: "Key Abnormal Notes", prod_add_row: "Add Row", prod_date: "Date Filter", loss_filter_period: "LOSS Filter:", loss_to: "to", btn_ai_summary: "AI Summary", btn_generate_report: "LOSS Brief", btn_psp_report: "PSP Close-Out Report", btn_undo_translate: "Undo Translate", btn_batch_delete: "Batch Delete", btn_export_excel: "Export Excel", btn_fast_parse: "Quick Parse", btn_ai_messy_parse: "AI Messy Parse", btn_cancel: "Cancel", btn_force_close: "Force Close", btn_ai_extract: "AI Extract", btn_quick_import: "Quick Import", btn_add_record: "Add Record", btn_confirm_save: "Confirm Save", btn_close: "Close", btn_compact: "Compact", btn_comfortable: "Comfortable", btn_save_continue: "OK, Save Anyway", btn_target_set: "Set Target", btn_setting_theme: "Theme", btn_setting_density: "Density", label_month: "Month", label_dept: "Dept/Area", label_record_count: "Records", label_completion_rate: "Close Rate", label_risk_pending: "Pending Risk", label_image_preview: "Preview", label_original_size: "Original", label_compressed: "Compressed", label_quality: "Quality", label_paste_ctrl_v: "Ctrl+V Paste Image", label_paste_hint: "Screenshot or copy image, then Ctrl+V", label_select_file: "Select File", label_theme_color: "Theme Color", label_display_density: "Display Density", modal_title_ai_report: "AI Analysis Report", modal_title_kaizen_import: "Kaizen Quick Import", modal_title_equip_photo: "Equipment Photo", modal_title_sys_detail: "System Ops Detail", modal_title_settings: "Page Settings", msg_system_prompt: "System Notice", msg_ready: "Ready", hint_settings_save: "Settings saved locally. No impact on cloud data.", improve_title: "Improve Tracking", improve_btn_poster: "Export Poster", improve_btn_excel: "Export Excel", improve_btn_add: "Add Project", improve_filter_label: "Filter:", improve_filter_dept: "Dept", improve_filter_status: "Status", improve_filter_date: "Start Date", improve_filter_to: "to", improve_opt_all: "All", improve_btn_month: "This Month", improve_total: "Total", improve_done: "Done", improve_prog: "In Prog", improve_over: "Overdue", improve_rate: "Rate", improve_thead_date: "Start Date", improve_thead_name: "Project Name", improve_thead_dept: "Dept", improve_thead_status: "Status", improve_thead_desc: "Progress", improve_thead_plan: "Plan End", improve_thead_del: "Del", improve_status_notstart: "Not Started", improve_status_prog: "In Progress", improve_status_done: "Completed", improve_status_over: "Overdue", improve_empty: "No projects yet, click Add to start", improve_placeholder_name: "Enter project name", improve_placeholder_desc: "Progress description", improve_opt_select: "Select", improve_confirm_del: "Confirm deletion?", improve_del_done: "Project deleted", improve_add_done: "Project added, please fill details", improve_not_found: "No projects found" },
            th: { sys_name: "Daily Management", menu_input: "บันทึกผลผลิต", menu_sys: "ระบบปฏิบัติการ", menu_monitor: "แดชบอร์ดรายวัน", menu_dm: "ปัญหาและแก้ไข", menu_loss: "ควบคุม LOSS", menu_trend: "วิเคราะห์แนวโน้ม", menu_target: "เป้าหมาย", menu_sim: "จำลองกำลังคน", menu_report: "รายงานภาพรวม", status_checking: "ตรวจสอบ...", status_online: "คลาวด์ออนไลน์", status_offline: "โหมดออฟไลน์", global_date: "วันที่:", drop_hint: "ปล่อยไฟล์", input_title: "บันทึกผลผลิตและกำลังคน", btn_import_prod: "นำเข้าไฟล์", btn_paste: "นำเข้าอัจฉริยะ", paste_title: "นำเข้าข้อมูลอัจฉริยะ", paste_sub: "วางข้อมูลจาก Excel", btn_ai_parse: "AI แยกข้อมูล", th_ws: "พื้นที่ / ไลน์", th_target: "แผนผลิต", th_output: "ทำได้จริง", th_hrs: "ชั่วโมง (H)", th_att: "มาทำงาน", th_head: "คนทั้งหมด", dash_title: "ประสิทธิภาพรายวัน", kpi_pro2_out: "ผลผลิต PRO2", kpi_pro2_loss: "LOSS", rank_title: "อันดับ LOSS", chart_title: "แผน vs ทำได้", dm_title1: "เช็คชื่อประชุม DM", dm_title2: "อัตราการประชุม", dm_th_am: "เช้า", dm_th_pm: "เย็น", dm_th_rank: "อันดับ", dm_th_should: "แผน", dm_th_actual: "จริง", dm_th_rate: "เปอร์เซ็นต์", prob_title: "ติดตามปัญหา", btn_add: "เพิ่มปัญหา", prob_th_date: "วันที่", prob_th_ws: "พื้นที่", prob_th_desc: "รายละเอียด", prob_th_loc: "ไลน์/กะ", prob_th_owner: "ผู้รับผิดชอบ", prob_th_dept: "แผนก", prob_th_status: "สถานะ", prob_th_del: "ลบ", btn_ai_trans: "แปลภาษา", loss_title: "บันทึกความสูญเสีย", btn_add_loss: "เพิ่ม LOSS", btn_ai_import: "AI นำเข้าอัจฉริยะ", loss_th_date: "วันที่", loss_th_line: "ไลน์", loss_th_shift: "กะ", loss_th_desc: "ปัญหา", loss_th_qty: "จำนวนสูญเสีย", loss_ai_title: "AI สกัด LOSS", loss_ai_sub: "วางข้อความ", trend_title: "วิเคราะห์แนวโน้มภาพรวม", trend_memo: "บันทึกประจำวัน", opt_upph: "แนวโน้ม UPPH", opt_o: "แนวโน้มผลผลิต", opt_loss: "แนวโน้ม LOSS", opt_h: "แนวโน้มชั่วโมง", opt_attrate: "แนวโน้มอัตราเข้างาน", opt_head: "แนวโน้มคนทั้งหมด", btn_ai_trend: "AI วิเคราะห์ข้อมูล", opt_7d: "7 วันล่าสุด", opt_15d: "15 วันล่าสุด", opt_30d: "30 วันล่าสุด", opt_month: "เดือนนี้", opt_all: "ทั้งหมด", opt_rep_day: "รายวัน", opt_rep_week: "รายสัปดาห์", opt_rep_month: "รายเดือน", btn_print: "พิมพ์รายงาน", rep_title: "รายงานสรุปการผลิต GAT", rep_period: "ช่วงเวลา:", r_out: "ผลผลิตรวม (PRO2)", r_upph: "UPPH เฉลี่ย (PRO2)", r_loss: "LOSS", r_att: "อัตราการมาทำงาน", r_dm: "ประชุม DM", r_prob: "ภาพรวมการแก้ปัญหา", r_prob_depts: "รายละเอียดแยกตามแผนก", r_chart1: "เปรียบเทียบผลผลิต", r_chart2: "แผนกที่เกิดปัญหา", ai_summary_title: "AI สรุปผล", btn_gen_ai: "สร้างรายงาน", r_loss_rank: "อันดับ LOSS", ws_label: "พื้นที่", act_label: "ทำได้จริง", tgt_label: "แผนผลิต", status_unres: "ยังไม่แก้", status_prog: "กำลังทำ", status_res: "แก้ไขแล้ว", normal: "ปกติ", add_line: "เพิ่มไลน์", prod_upph_title: "ผลสำเร็จ UPPH", prod_shift_title: "ผลผลิตแต่ละกะ PRO2", prod_pic: "ผู้รับผิดชอบ", prod_baseline: " Baseline 2025", prod_daily: "รายวัน", prod_monthly: "รวมเดือน", prod_output: "ผลผลิต", prod_working_hr: "ชม.ทำงาน", prod_upph: "UPPH", prod_imp_rate: "อัตราเด่น", prod_line: "LINE", prod_shift: "กะ", prod_target: "เป้าหมาย", prod_actual: "ทำได้", prod_rate: "อัตรา", prod_rank_d: "อันดับ (วัน)", prod_rank_m: "อันดับ (เดือน)", prod_del: "ลบ", prod_ttl: "รวม", prod_notes_title: "บันทึกผลกระทบสำคัญ", prod_add_row: "เพิ่มแถว", prod_date: "กรองวันที่", loss_filter_period: "กรองช่วง LOSS:", loss_to: "ถึง", btn_ai_summary: "AI สรุป", btn_generate_report: "รายงาน LOSS", btn_psp_report: "รายงานปิด PSP", btn_undo_translate: "ยกเลิกแปล", btn_batch_delete: "ลบทีเดียว", btn_export_excel: "ส่งออก Excel", date_today: "วันนี้", date_yesterday: "เมื่อวาน", date_this_month: "เดือนนี้", btn_fast_parse: "วิเคราะห์มาตรฐานด่วน", btn_ai_messy_parse: "AI แยกข้อมูล", btn_cancel: "ยกเลิก", btn_force_close: "ปิดบังคับ", btn_ai_extract: "AI สกัดข้อมูล", btn_quick_import: "นำเข้าด่วน", btn_add_record: "เพิ่มรายการ", btn_confirm_save: "บันทึก", btn_close: "ปิด", btn_compact: "กะทัดรัด", btn_comfortable: "สบาย", btn_save_continue: "บันทึกต่อ", btn_target_set: "ตั้งเป้าหมาย", btn_setting_theme: "ธีมสี", btn_setting_density: "ความหนาแน่น", label_month: "เดือน", label_dept: "แผนก/พื้นที่", label_record_count: "จำนวนรายการ", label_completion_rate: "อัตราสำเร็จ", label_risk_pending: "ความเสี่ยงรอติดตาม", label_image_preview: "ดูภาพ", label_original_size: "ขนาดเดิม", label_compressed: "หลังบีบอัด", label_quality: "คุณภาพ", label_paste_ctrl_v: "Ctrl+V วางภาพ", label_paste_hint: "แคปหน้าจอหรือคัดลอกรูปแล้วกด Ctrl+V", label_select_file: "เลือกไฟล์", label_theme_color: "ธีมสี", label_display_density: "ความหนาแน่น", modal_title_ai_report: "รายงาน AI วิเคราะห์", modal_title_kaizen_import: "นำเข้าโครงการ", modal_title_equip_photo: "รูปภาพตรวจสอบอุปกรณ์", modal_title_sys_detail: "รายละเอียดระบบปฏิบัติการ", modal_title_settings: "ตั้งค่าหน้า", msg_system_prompt: "ข้อความระบบ", msg_ready: "พร้อม", hint_settings_save: "การตั้งค่าถูกบันทึกไว้ในเบราว์เซอร์ ไม่มีผลต่อข้อมูลธุรกิจบนคลาวด์", improve_title: "ติดตามโครงการปรับปรุง", improve_btn_poster: "ส่งออกโปสเตอร์", improve_btn_excel: "ส่งออก Excel", improve_btn_add: "เพิ่มโครงการ", improve_filter_label: "กรอง:", improve_filter_dept: "แผนก", improve_filter_status: "สถานะ", improve_filter_date: "วันที่เริ่ม", improve_filter_to: "ถึง", improve_opt_all: "ทั้งหมด", improve_btn_month: "เดือนนี้", improve_total: "รวม", improve_done: "เสร็จ", improve_prog: "กำลังทำ", improve_over: "เกินกำหนด", improve_rate: "อัตรา", improve_thead_date: "วันที่เริ่ม", improve_thead_name: "ชื่อโครงการ", improve_thead_dept: "แผนก", improve_thead_status: "สถานะ", improve_thead_desc: "รายละเอียด", improve_thead_plan: "กำหนดเสร็จ", improve_thead_del: "ลบ", improve_status_notstart: "ยังไม่เริ่ม", improve_status_prog: "กำลังทำ", improve_status_done: "เสร็จแล้ว", improve_status_over: "เกินกำหนด", improve_empty: "ไม่มีโครงการ คลิก \u0022เพิ่มโครงการ\u0022 เพื่อเริ่ม", improve_placeholder_name: "กรุณากรอกชื่อโครงการ", improve_placeholder_desc: "รายละเอียดความคืบหน้า", improve_opt_select: "เลือก", improve_confirm_del: "ยืนยันลบโครงการนี้?", improve_del_done: "ลบโครงการแล้ว", improve_add_done: "เพิ่มโครงการแล้ว กรุณากรอกรายละเอียด", improve_not_found: "ไม่พบโครงการ" }
        };
        const factoryDict = [
            { zh: "C轴短缺导致线体停机", en: "C-shaft shortage causing line stop", th: "เพลา C ขาดแคลนทําให้ไลน์หยุด" },
            { zh: "设备模具偏移异常", en: "Equipment mold deviation", th: "แม่พิมพ์อุปกรณ์เบี่ยงเบนผิดปกติ" },
            { zh: "停机", en: "Machine Down", th: "เครื่องจักรหยุดทํางาน" },
            { zh: "缺料", en: "Material Shortage", th: "ขาดแคลนวัสดุ" },
            { zh: "品质异常", en: "Quality Defect", th: "คุณภาพผิดปกติ" }
        ];
        let currentLang = 'zh';
        function t(key) {
            return (i18n[currentLang] && i18n[currentLang][key]) || (i18n.zh && i18n.zh[key]) || key;
        }
        function translateUserText(text) {
            if (!text || currentLang === 'zh') return text || '';
            let result = String(text);
            factoryDict.forEach(item => {
                if (item.zh && item[currentLang]) result = result.split(item.zh).join(item[currentLang]);
            });
            return result;
        }
        window.changeLanguage = function(lang = 'zh') {
            currentLang = i18n[lang] ? lang : 'zh';
            const selector = document.getElementById('lang-selector');
            if (selector) selector.value = currentLang;
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (key && t(key) !== key) {
                    if (el.tagName === 'TITLE') { document.title = t(key); }
                    else { el.innerText = t(key); }
                }
            });
            // 确保浏览器标签标题同步
            document.title = t('sys_name');
            updateCloudStatus();
            if (isAppReady) refreshAllViews();
        };
        window.openSettings = function() { document.getElementById('settings-panel').style.display = 'flex'; };
        // ================= 全局数据安全函数 =================
        // 强制保存并同步到云端(用于关键操作)
        window.forceSaveAndSync = async function() {
            try {
                localStorage.setItem(DB_KEY, JSON.stringify(db));
                if (isFirebaseReady) {
                    await saveToFirebase();
                    console.log('Cloud sync completed');
                }
            } catch(e) {
                console.error('Force save failed:', e);
            }
        };

        // 安全关闭模态框(带数据保存)
        window.safeCloseModal = function(modalId) {
            try {
                repairData();
                triggerAutoSave();
                var modal = document.getElementById(modalId);
                if (modal) {
                    // 方法1:设置display为none
                    modal.style.display = 'none';
                    // 方法2:设置visibility为hidden
                    modal.style.visibility = 'hidden';
                    // 方法3:设置opacity为0
                    modal.style.opacity = '0';
                    // 方法4:设置pointer-events为none
                    modal.style.pointerEvents = 'none';
                    // 方法5:设置z-index为负值
                    modal.style.zIndex = '-1000';
                    // 方法6:添加隐藏类
                    modal.classList.add('hidden');

                    console.log('成功关闭模态框:', modalId);
                } else {
                    console.warn('模态框不存在:', modalId);
                }
            } catch(e) {
                console.error('关闭模态框时出错:', e);
                // 如果上面方法都失败了,尝试移除元素
                try {
                    var modal = document.getElementById(modalId);
                    if (modal && modal.parentNode) {
                        modal.parentNode.removeChild(modal);
                    }
                } catch(e2) {
                    console.error('移除模态框也失败:', e2);
                    // 最后尝试:重新加载页面(极端情况)
                    alert('模态框关闭失败,页面将刷新...');
                    window.location.reload();
                }
            }
        };

        // 强制关闭所有模态框
        window.forceCloseAllModals = function() {
            var modals = document.querySelectorAll('.modal-overlay, .loss-link-modal');
            modals.forEach(function(modal) {
                modal.style.display = 'none';
                modal.style.visibility = 'hidden';
                modal.style.opacity = '0';
                modal.style.pointerEvents = 'none';
                modal.style.zIndex = '-1000';
            });
            console.log('强制关闭了', modals.length, '个模态框');
            return modals.length;
        };

        // ESC键关闭模态框
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' || event.key === 'Esc') {
                console.log('ESC键被按下,尝试关闭模态框');
                var closed = forceCloseAllModals();
                if (closed === 0) {
                    console.log('没有打开的模态框');
                }
            }
        });

        // 页面加载时检查是否有卡住的模态框
        window.addEventListener('load', function() {
            setTimeout(function() {
                var visibleModals = document.querySelectorAll('.modal-overlay[style*="display: flex"], .modal-overlay[style*="display:block"], .modal-overlay:not([style*="display:none"])');
                if (visibleModals.length > 0) {
                    console.debug('检测到',visibleModals.length,'个模态框');
                    visibleModals.forEach(function(modal) {
                        console.log('卡住模态框:', modal.id || '无ID');
                    });
                }
            }, 1000);
        });

        // 安全关闭设置面板
        window.closeSettings = function() {
            repairData();
            triggerAutoSave();
            document.getElementById('settings-panel').style.display = 'none';
        };
        window.setTheme = function(theme) {
            var themes = ['','theme-ocean','theme-sky','theme-emerald','theme-carbon','theme-coral','theme-warm'];
            document.body.classList.remove.apply(document.body.classList, themes.filter(function(t){ return t; }));
            if(theme) document.body.classList.add(theme);
            localStorage.setItem('mbs_ui_theme', theme || '');
            document.querySelectorAll('.theme-swatch').forEach(function(s){ s.classList.remove('active'); });
            var idx = themes.indexOf(theme);
            if(idx < 0) idx = 0;
            var swatches = document.querySelectorAll('.theme-swatch');
            if(swatches[idx]) swatches[idx].classList.add('active');
            if (isAppReady) refreshAllViews();
        };
        window.setDensity = function(mode) {
            document.body.classList.toggle('density-comfortable', mode === 'comfortable');
            localStorage.setItem('mbs_ui_density', mode);
            if (isAppReady) showToast('fa-solid fa-sliders', mode === 'comfortable' ? '已切换舒适密度' : '已切换紧凑密度');
        };
        window.onload = function() {
            initApp().catch(err => {
                console.error('App init failed, fallback to local mode:', err);
                isCloudActive = false;
                injectSafeDemo();
                const date = document.getElementById('globalDate')?.value || new Date().toISOString().split('T')[0];
                ensureProdData(date); ensureDMData(date); ensureSysData(date);
                isAppReady = true;
                changeLanguage('zh');
                showToast('fa-solid fa-hard-drive', '云端数据异常,已启用本地防丢模式', 'error');
            });
        };
        // ========================================================================
        // 🎯 目标管理引擎 - 月度目标设定 → 每日达成追踪 → R/Y/G预警 → 剩余天数倒推
        // ========================================================================
        window.ensureTargetData = function() {
            if(!db.targetMgmt) db.targetMgmt = { targets:{}, dailyData:{} };
            return db.targetMgmt;
        };
        window.getTargetMonth = function() {
            let el = document.getElementById('targetMonth');
            if(!el.value) {
                let now = new Date();
                el.value = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
            }
            // 同步看板内嵌面板的目标月份
            var mm = document.getElementById('monitorTargetMonth');
            if(mm && !mm.value) mm.value = el.value;
            return el.value;
        };
        // ================= 目标管理:看板内嵌面板(toggle) =================
        window.toggleMonitorTarget = function() {
            var panel = document.getElementById('monitorTargetPanel');
            var btn = document.getElementById('monitorTargetToggleBtn');
            if(panel.style.display === 'none') {
                panel.style.display = 'block';
                btn.innerHTML = '<i class="fa-solid fa-xmark"></i> 关闭目标';
                btn.style.background = '#64748b';
                // 同步月份
                var mm = document.getElementById('monitorTargetMonth');
                var tm = document.getElementById('targetMonth');
                if(mm && tm) mm.value = tm.value || new Date().toISOString().slice(0,7);
                renderMonitorTarget();
            } else {
                panel.style.display = 'none';
                btn.innerHTML = '<i class="fa-solid fa-bullseye"></i> 目标管理';
                btn.style.background = '';
            }
        };
        window.renderMonitorTarget = function() {
            var contentEl = document.getElementById('monitorTargetContent');
            if(!contentEl) return;
            var tm = ensureTargetData();
            var month = document.getElementById('monitorTargetMonth').value;
            if(!month || month.length < 7) { contentEl.innerHTML='<div style="padding:20px;color:var(--text-muted);">请选择目标月份</div>'; return; }
            var [y,m] = month.split('-').map(Number);
            var daysInMonth = new Date(y,m,0).getDate();
            var today = new Date();
            var todayStr = today.toISOString().split('T')[0];
            var dayOfMonth = today.getDate();
            if(!tm.targets[month]) {
                tm.targets[month] = { lines: {} };
                ['PRO1','PRO2','PRO3','PRO4'].forEach(function(ws) {
                    var avgOut = 0, avgHr = 0, count = 0;
                    Object.keys(db.prod).forEach(function(d) {
                        if(d.startsWith(month) && db.prod[d][ws]) {
                            avgOut += Number(db.prod[d][ws].o||0);
                            avgHr += Number(db.prod[d][ws].h||0);
                            count++;
                        }
                    });
                    if(count > 0) { avgOut = Math.round(avgOut/count); avgHr = Math.round(avgHr/count*10)/10; }
                    tm.targets[month].lines[ws] = {
                        dailyTarget: avgOut || 1000,
                        dailyUPPH: avgHr > 0 ? Math.round((avgOut/avgHr)*10)/10 : 23.5,
                        headcount: 50
                    };
                });
            }
            var targets = tm.targets[month].lines;
            var passedDays = 0;
            for(var d=1; d<=dayOfMonth; d++) {
                var dStr = month + '-' + String(d).padStart(2,'0');
                if(dStr <= todayStr) passedDays++;
            }
            var remainingDays = daysInMonth - dayOfMonth;
            var html = '';
            // 横幅
            var totalDailyTarget = Object.values(targets).reduce(function(s,v){ return s + Number(v.dailyTarget||0); }, 0);
            var computedMonthlyTarget = totalDailyTarget * daysInMonth;
            // 支持用户自己填写的月产出目标(可编辑)
            if(!tm.targets[month].monthlyOutputTarget) {
                tm.targets[month].monthlyOutputTarget = computedMonthlyTarget;
            }
            var monthlyTarget = Number(tm.targets[month].monthlyOutputTarget) || computedMonthlyTarget;
            var achievedSoFar = 0;
            Object.keys(db.prod).forEach(function(d) {
                if(!d.startsWith(month)) return;
                Object.keys(targets).forEach(function(ws) {
                    if(db.prod[d] && db.prod[d][ws]) achievedSoFar += Number(db.prod[d][ws].o||0);
                });
            });
            var monthlyRate = monthlyTarget > 0 ? (achievedSoFar/monthlyTarget*100) : 0;
            var bannerColor = monthlyRate >= 90 ? 'var(--success)' : (monthlyRate >= 70 ? 'var(--warning)' : 'var(--danger)');
            html += '<div style="display:flex; justify-content:space-between; align-items:center; background:var(--midea-blue); color:white; border-radius:var(--radius); padding:14px 20px; margin-bottom:12px;">';
            html += '<div><span style="font-size:20px; font-weight:900;">'+month+'</span><span style="margin-left:10px;font-size:12px;opacity:0.85;">全厂月度目标</span></div>';
            html += '<div style="display:flex; gap:16px;">';
            html += '<div style="text-align:center;"><div style="font-size:22px; font-weight:900;">'+achievedSoFar.toLocaleString()+'</div><div style="font-size:10px; opacity:0.85;">目前达成</div></div>';
            html += '<div style="text-align:center;"><input type="number" id="monthlyTargetInput" value="'+monthlyTarget+'" onchange="saveMonthlyTarget(this.value)" style="width:100px;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:4px;color:white;font-size:18px;font-weight:900;text-align:center;padding:4px 2px;"><div style="font-size:10px; opacity:0.85;"><i class="fa-solid fa-pen"></i> 月产出目标(可编辑)</div></div>';
            html += '<div style="text-align:center;"><div style="font-size:22px; font-weight:900;color:'+bannerColor+'">'+monthlyRate.toFixed(1)+'%</div><div style="font-size:10px; opacity:0.85;">达成率</div></div>';
            html += '<div style="text-align:center;"><div style="font-size:22px; font-weight:900;color:var(--warning)">'+remainingDays+'</div><div style="font-size:10px; opacity:0.85;">剩余天数</div></div>';
            html += '</div></div>';
            // 各个WS追赶卡片
            html += '<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px;">';
            Object.keys(targets).sort().forEach(function(ws) {
                var t = targets[ws];
                var wsAchieved = 0, wsDaysDone = 0;
                Object.keys(db.prod).forEach(function(d) {
                    if(d.startsWith(month) && db.prod[d] && db.prod[d][ws]) {
                        wsAchieved += Number(db.prod[d][ws].o||0);
                        wsDaysDone++;
                    }
                });
                var wsMonthlyTarget = Number(t.dailyTarget||0) * daysInMonth;
                var wsRate = wsMonthlyTarget > 0 ? (wsAchieved/wsMonthlyTarget*100) : 0;
                var neededRemaining = remainingDays > 0 ? Math.max(0, (wsMonthlyTarget - wsAchieved) / remainingDays) : 0;
                var statusClass = wsRate >= 90 ? '' : (wsRate >= 70 ? '' : '');
                var fillColor = wsRate >= 90 ? 'var(--success)' : (wsRate >= 70 ? 'var(--warning)' : 'var(--danger)');
                var borderLeft = wsRate >= 90 ? '4px solid var(--success)' : (wsRate >= 70 ? '4px solid var(--warning)' : '4px solid var(--danger)');
                html += '<div style="background:#f8fafc; border-radius:var(--radius); padding:12px; border-left:'+borderLeft+';">';
                html += '<div style="font-weight:800;font-size:13px;color:var(--midea-dark);margin-bottom:4px;">'+ws+'</div>';
                html += '<div style="height:6px;background:rgba(0,0,0,0.06);border-radius:3px;margin:6px 0;overflow:hidden;"><div style="height:100%;border-radius:3px;width:'+Math.min(100,wsRate)+'%;background:'+fillColor+';transition:width 0.5s;"></div></div>';
                html += '<div style="display:flex;justify-content:space-between;font-size:11px;font-weight:600;">';
                html += '<span>达成 <span style="font-weight:900;font-size:13px;color:'+fillColor+'">'+wsRate.toFixed(1)+'%</span></span>';
                html += '<span>日目标 <span style="font-weight:900;">'+(Number(t.dailyTarget||0)).toLocaleString()+'</span></span>';
                html += '</div>';
                html += '<div style="display:flex;justify-content:space-between;font-size:10px;margin-top:3px;">';
                html += '<span>累计 <b>'+wsAchieved.toLocaleString()+'</b> / '+wsMonthlyTarget.toLocaleString()+'</span>';
                html += '<span style="color:'+(neededRemaining > Number(t.dailyTarget||0) ? 'var(--danger)' : 'var(--success)')+'">追赶 <b>'+Math.round(neededRemaining).toLocaleString()+'</b>/天</span>';
                html += '</div></div>';
            });
            html += '</div>';
            contentEl.innerHTML = html;
        };
        window.saveMonthlyTarget = function(val) {
            var tm = ensureTargetData();
            var month = document.getElementById('monitorTargetMonth').value;
            if(!tm.targets[month]) tm.targets[month] = { lines: {} };
            tm.targets[month].monthlyOutputTarget = Number(val) || 0;
            triggerAutoSave();
            renderMonitorTarget();
        };
        window.showMonitorTargetEdit = function() {
            var tm = ensureTargetData();
            var month = document.getElementById('monitorTargetMonth').value;
            if(!tm.targets[month]) tm.targets[month] = { lines: {} };
            var targets = tm.targets[month].lines;
            var html = '<h4 style="margin-bottom:12px;">🎯 '+month+' 月度目标设定</h4>';
            html += '<div style="display:grid; grid-template-columns:100px 1fr 1fr 1fr; gap:8px; align-items:center; margin-bottom:8px; padding:6px 0; border-bottom:1px solid var(--border-light); font-weight:800; color:var(--midea-dark); font-size:12px;">';
            html += '<span>产线</span><span>日产出目标</span><span>目标UPPH</span><span>定编人数</span></div>';
            ['PRO1','PRO2','PRO3','PRO4'].forEach(function(ws) {
                if(!targets[ws]) targets[ws] = { dailyTarget:1000, dailyUPPH:23.5, headcount:50 };
                html += '<div style="display:grid; grid-template-columns:100px 1fr 1fr 1fr; gap:8px; align-items:center; margin-bottom:6px; padding:6px 0; border-bottom:1px solid var(--border-light);">';
                html += '<span style="font-weight:800;color:var(--midea-blue);">'+ws+'</span>';
                html += '<input type="number" value="'+(targets[ws].dailyTarget||1000)+'" onchange="saveTargetConfig(\''+ws+'\',\'dailyTarget\',this.value);renderMonitorTarget()" style="width:90px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;text-align:center;font-size:12px;">';
                html += '<input type="number" step="0.1" value="'+(targets[ws].dailyUPPH||23.5)+'" onchange="saveTargetConfig(\''+ws+'\',\'dailyUPPH\',this.value);renderMonitorTarget()" style="width:90px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;text-align:center;font-size:12px;">';
                html += '<input type="number" value="'+(targets[ws].headcount||50)+'" onchange="saveTargetConfig(\''+ws+'\',\'headcount\',this.value);renderMonitorTarget()" style="width:90px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;text-align:center;font-size:12px;">';
                html += '</div>';
            });
            showModal('目标设定', html);
        };
        window.renderTargetMgmt = function() {
            // 旧独立目标页已移除,目标管理整合至每日生产看板
            // 使用 renderMonitorTarget() 替代
            return;
            if(!month || month.length < 7) { document.getElementById('targetContent').innerHTML='<div style="padding:20px;color:var(--text-muted);">请选择目标月份</div>'; return; }
            let [y,m] = month.split('-').map(Number);
            let daysInMonth = new Date(y,m,0).getDate();
            let today = new Date();
            let todayStr = today.toISOString().split('T')[0];
            let dayOfMonth = today.getDate();
            // 确保产线目标默认数据
            if(!tm.targets[month]) {
                tm.targets[month] = { lines: {} };
                ['PRO1','PRO2','PRO3','PRO4'].forEach(ws => {
                    // 从prod数据推算均值
                    let avgOut = 0, avgHr = 0, count = 0;
                    Object.keys(db.prod).forEach(d => {
                        if(d.startsWith(month) && db.prod[d][ws]) {
                            avgOut += Number(db.prod[d][ws].o||0);
                            avgHr += Number(db.prod[d][ws].h||0);
                            count++;
                        }
                    });
                    if(count > 0) { avgOut = Math.round(avgOut/count); avgHr = Math.round(avgHr/count*10)/10; }
                    tm.targets[month].lines[ws] = {
                        dailyTarget: avgOut || 1000,
                        dailyUPPH: avgHr > 0 ? Math.round((avgOut/avgHr)*10)/10 : 23.5,
                        headcount: 50
                    };
                });
            }
            let targets = tm.targets[month].lines;
            // 计算已过天数
            let passedDays = 0;
            for(let d=1; d<=dayOfMonth; d++) {
                let dStr = month + '-' + String(d).padStart(2,'0');
                if(dStr <= todayStr) passedDays++;
            }
            let remainingDays = daysInMonth - dayOfMonth;
            // 构建HTML
            let html = '';
            // 横幅
            let totalDailyTarget = Object.values(targets).reduce((s,v) => s + Number(v.dailyTarget||0), 0);
            let monthlyTarget = totalDailyTarget * daysInMonth;
            let achievedSoFar = 0;
            Object.keys(db.prod).forEach(d => {
                if(!d.startsWith(month)) return;
                Object.keys(targets).forEach(ws => {
                    if(db.prod[d] && db.prod[d][ws]) achievedSoFar += Number(db.prod[d][ws].o||0);
                });
            });
            let monthlyRate = monthlyTarget > 0 ? (achievedSoFar/monthlyTarget*100) : 0;
            let bannerColor = monthlyRate >= 90 ? 'var(--success)' : (monthlyRate >= 70 ? 'var(--warning)' : 'var(--danger)');
            html += `<div class="target-banner">
                <div><span class="t-month">${month}</span><span style="margin-left:10px;font-size:13px;opacity:0.85;">全厂月度目标</span></div>
                <div class="t-summary">
                    <div class="t-stat"><div class="t-s-val">${achievedSoFar.toLocaleString()}</div><div class="t-s-label">目前达成</div></div>
                    <div class="t-stat"><div class="t-s-val">${monthlyTarget.toLocaleString()}</div><div class="t-s-label">月度目标</div></div>
                    <div class="t-stat"><div class="t-s-val" style="color:${bannerColor}">${monthlyRate.toFixed(1)}%</div><div class="t-s-label">达成率</div></div>
                    <div class="t-stat"><div class="t-s-val" style="color:var(--warning)">${remainingDays}</div><div class="t-s-label">剩余天数</div></div>
                </div>
            </div>`;
            // 各个WS的每日追赶目标
            html += '<div class="target-chase-grid">';
            Object.keys(targets).sort().forEach(ws => {
                let t = targets[ws];
                let wsAchieved = 0, wsDaysDone = 0;
                Object.keys(db.prod).forEach(d => {
                    if(d.startsWith(month) && db.prod[d] && db.prod[d][ws]) {
                        wsAchieved += Number(db.prod[d][ws].o||0);
                        wsDaysDone++;
                    }
                });
                let wsMonthlyTarget = Number(t.dailyTarget||0) * daysInMonth;
                let wsRate = wsMonthlyTarget > 0 ? (wsAchieved/wsMonthlyTarget*100) : 0;
                let neededRemaining = remainingDays > 0 ? Math.max(0, (wsMonthlyTarget - wsAchieved) / remainingDays) : 0;
                let statusClass = wsRate >= 90 ? 'success' : (wsRate >= 70 ? 'warning' : 'danger');
                let fillColor = wsRate >= 90 ? 'var(--success)' : (wsRate >= 70 ? 'var(--warning)' : 'var(--danger)');
                html += `<div class="chase-item ${statusClass}">
                    <div class="ci-ws">${ws}</div>
                    <div class="ci-progress"><div class="ci-fill" style="width:${Math.min(100,wsRate)}%;background:${fillColor}"></div></div>
                    <div class="ci-stats">
                        <span>达成 <span class="ci-val" style="color:${fillColor}">${wsRate.toFixed(1)}%</span></span>
                        <span>日目标 <span class="ci-val">${(Number(t.dailyTarget||0)).toLocaleString()}</span></span>
                    </div>
                    <div class="ci-stats" style="margin-top:3px;font-size:10px;">
                        <span>累计 <b>${wsAchieved.toLocaleString()}</b> / ${wsMonthlyTarget.toLocaleString()}</span>
                        <span style="color:${neededRemaining > Number(t.dailyTarget||0) ? 'var(--danger)' : 'var(--success)'};">追赶 <b>${Math.round(neededRemaining).toLocaleString()}</b>/天</span>
                    </div>
                </div>`;
            });
            html += '</div>';
            // 预警汇总
            html += '<div style="margin-top:10px;">';
            let warnings = [];
            Object.keys(targets).sort().forEach(ws => {
                let t = targets[ws];
                let wsAchieved = 0, wsDaysDone = 0;
                Object.keys(db.prod).forEach(d => {
                    if(d.startsWith(month) && db.prod[d] && db.prod[d][ws]) {
                        wsAchieved += Number(db.prod[d][ws].o||0);
                        wsDaysDone++;
                    }
                });
                let wsMonthlyTarget = Number(t.dailyTarget||0) * daysInMonth;
                let wsRate = wsMonthlyTarget > 0 ? (wsAchieved/wsMonthlyTarget*100) : 0;
                let needed = remainingDays > 0 ? Math.max(0, (wsMonthlyTarget - wsAchieved) / remainingDays) : 0;
                if(wsRate < 70) {
                    warnings.push({ ws, rate:wsRate, needed, severity:'danger', icon:'🔴', msg:`严重落后 (${wsRate.toFixed(0)}%), 每日需追${Math.round(needed)}件` });
                } else if(wsRate < 90) {
                    warnings.push({ ws, rate:wsRate, needed, severity:'warning', icon:'🟡', msg:`需关注 (${wsRate.toFixed(0)}%), 每日需追${Math.round(needed)}件` });
                } else {
                    warnings.push({ ws, rate:wsRate, needed, severity:'success', icon:'🟢', msg:`正常 (${wsRate.toFixed(0)}%), 按当前节奏可达成` });
                }
            });
            warnings.forEach(w => {
                html += `<div class="target-alert-bar ${w.severity}"><span style="font-size:16px;">${w.icon}</span> <b>${w.ws}</b> - ${w.msg}</div>`;
            });
            html += '</div>';
            // 今日追赶目标卡片
            html += '<div style="margin-top:12px;display:flex;gap:12px;">';
            Object.keys(targets).sort().forEach(ws => {
                let t = targets[ws];
                let wsAchieved = 0;
                Object.keys(db.prod).forEach(d => {
                    if(d.startsWith(month) && db.prod[d] && db.prod[d][ws]) wsAchieved += Number(db.prod[d][ws].o||0);
                });
                let wsMonthlyTarget = Number(t.dailyTarget||0) * daysInMonth;
                let needed = remainingDays > 0 ? Math.max(0, (wsMonthlyTarget - wsAchieved) / remainingDays) : 0;
                let dailyTarget = Number(t.dailyTarget||0);
                html += `<div class="target-chase-card" style="flex:1; min-width:160px;">
                    <div style="font-weight:800;font-size:13px;color:var(--midea-dark);">${ws} 今日追赶</div>
                    <div style="font-size:28px;font-weight:900;color:${needed > dailyTarget*1.2 ? 'var(--danger)' : 'var(--midea-blue)'};">${Math.round(needed).toLocaleString()}</div>
                    <div style="font-size:11px;color:var(--text-muted);">件 (日常${dailyTarget.toLocaleString()}件)</div>
                </div>`;
            });
            html += '</div>';
            document.getElementById('targetContent').innerHTML = html;
            // 更新导航角标
            let hasDanger = warnings.some(w => w.severity === 'danger');
            let badge = document.getElementById('target-nav-warn');
            if(badge) {
                badge.style.display = hasDanger ? 'inline' : 'none';
                badge.textContent = hasDanger ? '!' : '';
            }
        };
        window.showTargetEdit = function() {
            let tm = ensureTargetData();
            let month = getTargetMonth();
            if(!tm.targets[month]) tm.targets[month] = { lines: {} };
            let targets = tm.targets[month].lines;
            let html = `<h4>🎯 ${month} 月度目标设定</h4>`;
            html += '<div class="target-row" style="font-weight:800;color:var(--midea-dark);"><span class="tr-label">产线</span><span class="tr-label">日产出目标</span><span class="tr-label">目标UPPH</span><span class="tr-label">定编人数</span></div>';
            ['PRO1','PRO2','PRO3','PRO4'].forEach(ws => {
                if(!targets[ws]) targets[ws] = { dailyTarget:1000, dailyUPPH:23.5, headcount:50 };
                html += `<div class="target-row">
                    <span style="font-weight:800;color:var(--midea-blue);">${ws}</span>
                    <input type="number" value="${targets[ws].dailyTarget||1000}" onchange="saveTargetConfig('${ws}','dailyTarget',this.value)">
                    <input type="number" step="0.1" value="${targets[ws].dailyUPPH||23.5}" onchange="saveTargetConfig('${ws}','dailyUPPH',this.value)">
                    <input type="number" value="${targets[ws].headcount||50}" onchange="saveTargetConfig('${ws}','headcount',this.value)">
                </div>`;
            });
            html += '<div style="margin-top:8px;"><button class="btn btn-success" onclick="closeTargetEdit();renderTargetMgmt()">确定</button></div>';
            // 用轻提示模态展示
            showModal('目标设定', html);
        };
        window.saveTargetConfig = function(ws, field, val) {
            let tm = ensureTargetData();
            let month = getTargetMonth();
            if(!tm.targets[month]) tm.targets[month] = { lines: {} };
            if(!tm.targets[month].lines[ws]) tm.targets[month].lines[ws] = { dailyTarget:1000, dailyUPPH:23.5, headcount:50 };
            tm.targets[month].lines[ws][field] = Number(val);
            triggerAutoSave();
        };
        window.closeTargetEdit = function() {
            let ov = document.querySelector('.modal-overlay');
            if(ov) ov.remove();
        };
        window.showModal = function(title, content) {
            let overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:9999;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `<div style="background:white;border-radius:14px;padding:24px;min-width:500px;max-width:700px;box-shadow:0 20px 50px rgba(0,0,0,0.15);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><h3 style="margin:0;color:var(--midea-dark);font-weight:900;">${title}</h3><button onclick="this.closest('.modal-overlay').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);">✕</button></div><div>${content}</div></div>`;
            document.body.appendChild(overlay);
        };
        window.exportTargetPoster = function() {
            let content = document.getElementById('targetContent');
            if(!content) return showToast('fa-solid fa-warning','无目标数据');
            let win = window.open('', '_blank');
            if(!win) { showToast('fa-solid fa-warning', '请允许弹窗'); return; }
            let styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).map(s => s.outerHTML).join('');
            win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>目标管理看板</title>'+styles+'<style>body{padding:20px;}@media print{@page{size:A4 landscape;margin:8mm;}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style></head><body>');
            win.document.write(content.innerHTML);
            win.document.write('</body></html>');
            win.document.close();
            setTimeout(function() { win.focus(); win.print(); }, 500);
            showToast('fa-solid fa-file-image', '已生成目标看板,请在打印窗口另存为PDF');
        };
        // ========================================================================
        // 🧮 标准工时 & 人员推演
        // ========================================================================
        window.ensureSimData = function() {
            if(!db.simConfig) db.simConfig = { lines:[] };
            if(db.simConfig.lines.length === 0) {
                // 默认值:A线8秒, B/C线7.5秒, D线8秒;工作时间上午10h10min+晚上9h30min=1180min
                var _defaults = {
                    'LINE A': { stdTime: 8, taktTime: 8 },
                    'LINE B': { stdTime: 7.5, taktTime: 7.5 },
                    'LINE C': { stdTime: 7.5, taktTime: 7.5 },
                    'LINE D': { stdTime: 8, taktTime: 8 }
                };
                ['LINE A','LINE B','LINE C','LINE D'].forEach(function(name) {
                    var d = _defaults[name];
                    db.simConfig.lines.push({
                        name: name,
                        ws: { 'LINE A':'PRO1','LINE B':'PRO2','LINE C':'PRO3','LINE D':'PRO4' }[name] || 'PRO2',
                        stdTime: d.stdTime,
                        taktTime: d.taktTime,
                        workingMin: 1180,
                        headcount: 50,
                        outputToday: 0
                    });
                });
            }
            return db.simConfig;
        };
        window.renderSimConfig = function() {
            if(document.getElementById('p-sim') && !document.getElementById('p-sim').classList.contains('active')) return;
            let sim = ensureSimData();
            let rowsHtml = '';
            sim.lines.forEach((line, idx) => {
                rowsHtml += `<div class="sim-row" data-idx="${idx}">
                    <label>${line.name}</label>
                    <span style="font-size:11px;color:var(--text-muted);min-width:50px;">${line.ws}</span>
                    <span>标准工时 <input type="number" value="${line.stdTime}" onchange="updateSimLine(${idx},'stdTime',this.value)" step="0.1"></span>
                    <span class="sim-unit">秒/件</span>
                    <span>T/T <input type="number" value="${line.taktTime}" onchange="updateSimLine(${idx},'taktTime',this.value)" step="0.1"></span>
                    <span class="sim-unit">秒</span>
                    <span>工作时间 <input type="number" value="${line.workingMin}" onchange="updateSimLine(${idx},'workingMin',this.value)" step="5"></span>
                    <span class="sim-unit">分钟</span>
                    <button onclick="delSimLine(${idx})" style="background:none;border:none;color:var(--danger);cursor:pointer;"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
            });
            var _sce=document.getElementById('simConfigRows');if(_sce)_sce.innerHTML=rowsHtml;
        };
        window.renderSimAttendance = function() {
            if(document.getElementById('p-sim') && !document.getElementById('p-sim').classList.contains('active')) return;
            let sim = ensureSimData();
            // 从prod数据获取当天出勤
            let date = window.safeDOM.val("globalDate");
            let html = '';
            sim.lines.forEach((line, idx) => {
                let actualHead = 0;
                let ws = line.ws;
                if(db.prod[date] && db.prod[date][ws]) {
                    actualHead = Number(db.prod[date][ws].att||0);
                }
                html += `<div class="sim-row">
                    <label>${line.name}</label>
                    <span>配置人数 <input type="number" value="${line.headcount}" onchange="updateSimLine(${idx},'headcount',this.value)"></span>
                    <span>实际出勤 <span style="font-weight:900;font-size:15px;color:var(--midea-blue);">${actualHead}</span> 人</span>
                    <span>今日产出 <span style="font-weight:900;">${Number(db.prod[date] && db.prod[date][ws] ? db.prod[date][ws].o||0 : 0).toLocaleString()}</span> 件</span>
                </div>`;
            });
            var _sae=document.getElementById('simAttendanceRows');if(_sae)_sae.innerHTML=html;
        };
        window.updateSimLine = function(idx, field, val) {
            let sim = ensureSimData();
            if(sim.lines[idx]) {
                sim.lines[idx][field] = Number(val);
                triggerAutoSave();
                renderSimConfig();
                renderSimAttendance();
            }
        };
        window.addSimLine = function() {
            let sim = ensureSimData();
            sim.lines.push({ name:'新线体', ws:'PRO2', stdTime:60, taktTime:45, workingMin:540, headcount:30, outputToday:0 });
            triggerAutoSave();
            renderSimConfig();
            renderSimAttendance();
        };
        window.delSimLine = function(idx) {
            let sim = ensureSimData();
            sim.lines.splice(idx, 1);
            _deferredLocalStorageSave();
            setTimeout(function(){
                if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else { triggerAutoSave(); }
            }, 0);
            renderSimConfig();
            renderSimAttendance();
        };
        window.saveSimConfig = function() {
            triggerAutoSave();
            showToast('fa-solid fa-floppy-disk', '配置已保存', 'success');
        };
        window.runSimulation = function() {
            let sim = ensureSimData();
            let date = window.safeDOM.val("globalDate");
            let resultsHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <h4 style="margin:0;color:var(--midea-dark);font-weight:800;"><i class="fa-solid fa-chart-bar"></i> 📊 人员匹配分析结果 (${date})</h4>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-ai" onclick="runWhatIfSim()"><i class="fa-solid fa-flask"></i> 🧪 减人What-If</button>
                    <button class="btn btn-success" onclick="exportSimPoster()"><i class="fa-solid fa-download"></i> 导出</button>
                </div>
            </div>`;
            resultsHtml += `<table class="sim-table">
                <tr><th>产线</th><th>标准工时(s)</th><th>T/T(s)</th><th>理论产能</th><th>定编人数</th><th>实际出勤</th><th>今日产出</th><th>人员判定</th><th>理论需人</th></tr>`;
            let totalSurplus = 0, totalShortage = 0;
            sim.lines.forEach(line => {
                let ws = line.ws;
                let actualHead = Number(db.prod[date] && db.prod[date][ws] ? db.prod[date][ws].att||0 : 0);
                // 理论产能 = 工作时间(分钟) * 60 / T/T(秒)
                let theoreticalOutput = Math.floor(line.workingMin * 60 / line.taktTime);
                // 理论需要人数 = 实际产出 * 标准工时 / (工作时间 * 60)
                let actualOutput = Number(db.prod[date] && db.prod[date][ws] ? db.prod[date][ws].o||0 : 0);
                let theoreticalNeeded = line.stdTime * actualOutput / (line.workingMin * 60);
                let diff = actualHead - Math.round(theoreticalNeeded);
                let statusClass = Math.abs(diff) <= 2 ? 'adequate' : 'surplus';
                let statusIcon = diff > 2 ? '🔴 冗余' : (diff < -2 ? '🔴 缺人' : '🟢 合适');
                if(diff > 2) totalSurplus += (diff - 2);
                if(diff < -2) totalShortage += Math.abs(diff + 2);
                resultsHtml += `<tr>
                    <td style="font-weight:800;">${line.name}</td>
                    <td>${line.stdTime}</td>
                    <td>${line.taktTime}</td>
                    <td>${theoreticalOutput.toLocaleString()}</td>
                    <td>${line.headcount}</td>
                    <td>${actualHead}</td>
                    <td>${actualOutput.toLocaleString()}</td>
                    <td class="${statusClass}">${statusIcon} ${diff > 0 ? '+' : ''}${diff}人</td>
                    <td>${Math.round(theoreticalNeeded)}</td>
                </tr>`;
            });
            resultsHtml += `<tr style="background:var(--midea-blue);color:white;font-weight:900;">
                <td colspan="7" style="text-align:right;">合计冗余 <span id="simTotalSurplus">${totalSurplus}</span> 人 / 缺口 <span id="simTotalShortage">${totalShortage}</span> 人</td>
                <td colspan="2">${totalSurplus > 0 ? `⚠️ 可优化 ${totalSurplus} 人` : '✅ 人员匹配合理'}</td>
            </tr>`;
            resultsHtml += '</table>';
            // What-If面板
            resultsHtml += `<div class="sim-whatif" id="whatIfPanel">
                <div style="display:flex;gap:12px;align-items:end;flex-wrap:wrap;">
                    <div><label>🧪 假设减人</label><br><input type="number" id="whatIfReduce" value="5" min="0" style="width:70px;padding:4px;border:1px solid var(--border);border-radius:4px;"> 人</div>
                    <div><label>从产线</label><br><select id="whatIfLine" style="padding:4px;">${sim.lines.map((l,i) => `<option value="${i}">${l.name}</option>`).join('')}</select></div>
                    <button class="btn btn-primary" onclick="runWhatIfSim()" style="font-size:12px;">计算影响</button>
                </div>
                <div id="whatIfResult" style="margin-top:8px;padding:10px;background:var(--bg-base);border-radius:6px;font-size:12px;">点击「减人What-If」或「计算影响」查看假设结果</div>
            </div>`;
            document.getElementById('simResults').innerHTML = resultsHtml;
            showToast('fa-solid fa-check-circle', '人员匹配分析完成', 'success');
        };
        window.runWhatIfSim = function() {
            let sim = ensureSimData();
            let date = window.safeDOM.val("globalDate");
            let reduce = Number(document.getElementById('whatIfReduce')?.value || 5);
            let lineIdx = Number(document.getElementById('whatIfLine')?.value || 0);
            let line = sim.lines[lineIdx];
            if(!line) return;
            let ws = line.ws;
            let actualHead = Number(db.prod[date] && db.prod[date][ws] ? db.prod[date][ws].att||0 : 0);
            if(actualHead <= 0) {
                document.getElementById('whatIfResult').innerHTML = '<div style="padding:10px;color:var(--danger);">⚠️ 当前日期该产线无出勤数据,无法计算减人影响</div>';
                return;
            }
            let newHead = Math.max(1, actualHead - reduce);
            // ✨ 正确算法:用实际产出和实际人数推算人均效率,而非理论标准时间推算
            // 原来的问题:理论产能(newHead*workingMin*60/stdTime) 和实际产出(currentOutput)不是同一个量级,对比结果完全失真
            // 新算法:产出变化 = 实际产出 × (新人数 / 当前人数)
            // 即保持人均产能不变,产出随人员比例变化
            let currentOutput = Number(db.prod[date] && db.prod[date][ws] ? db.prod[date][ws].o||0 : 0);
            let newOutput = Math.round(currentOutput * newHead / actualHead);
            let outputChange = newOutput - currentOutput;
            let impact = currentOutput > 0 ? (outputChange / currentOutput * 100) : 0;
            // 减人后UPPH = 新产出 / (新人数 × 工作小时)
            // 从workingMin(分钟) 转换为小时
            let workingHr = line.workingMin / 60;
            let newUPPH = workingHr > 0 && newHead > 0 ? parseFloat((newOutput / (newHead * workingHr)).toFixed(2)) : 0;
            let html = '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">' +
                '<div class="sim-result-card"><div class="sim-big" style="font-size:24px;">' + actualHead + ' → ' + newHead + '</div><div class="sim-label">' + line.name + ' 出勤人数变化</div></div>' +
                '<div class="sim-result-card"><div class="sim-big" style="font-size:24px;color:' + (outputChange < 0 ? 'var(--danger)' : 'var(--success)') + ';">' + currentOutput.toLocaleString() + ' → ' + newOutput.toLocaleString() + '</div><div class="sim-label">预估产出变化 (' + impact.toFixed(1) + '%)</div></div>' +
                '<div class="sim-result-card"><div class="sim-big" style="font-size:24px;">' + newUPPH + '</div><div class="sim-label">减人后UPPH</div></div>' +
            '</div>';
            // 补充一行提示:显示该产线当前的实际人均效率
            var effPerPerson = currentOutput > 0 && actualHead > 0 ? (currentOutput / actualHead).toFixed(0) : '-';
            html += '<div style="margin-top:6px;font-size:11px;color:var(--text-muted);text-align:center;">当前人均产出: ' + effPerPerson + ' 件/人·日 (按实际全勤数据统计)</div>';
            html += '<div style="margin-top:8px;padding:8px 12px;background:' + (impact < -5 ? 'rgba(211,47,47,0.1)' : 'rgba(46,125,50,0.1)') + ';border-radius:6px;font-weight:700;font-size:13px;color:' + (impact < -5 ? 'var(--danger)' : 'var(--success)') + ';">' +
                (impact < -5 ? '⚠️ 减' + reduce + '人可能导致产出下降 ' + Math.abs(impact).toFixed(1) + '%,建议先通过改善ST/自动化补偿' : (impact <= -2 ? '⚠️ 减' + reduce + '人影响较小,产出预计下降 ' + Math.abs(impact).toFixed(1) + '%' : '✅ 减' + reduce + '人影响可控,产出预计变化 ' + impact.toFixed(1) + '%')) +
            '</div>';
            document.getElementById('whatIfResult').innerHTML = html;
        };
        window.exportSimPoster = function() {
            let content = document.getElementById('simResults');
            if(!content) return showToast('fa-solid fa-warning','请先运行分析');
            let win = window.open('', '_blank');
            if(!win) { showToast('fa-solid fa-warning', '请允许弹窗'); return; }
            let styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).map(s => s.outerHTML).join('');
            win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>人员推演报告</title>'+styles+'<style>body{padding:20px;}@media print{@page{size:A4 landscape;margin:8mm;}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style></head><body>');
            win.document.write(content.innerHTML);
            win.document.write('</body></html>');
            win.document.close();
            setTimeout(function() { win.focus(); win.print(); }, 500);
        };
        // ========================================================================
        // 📈 月度复盘报告增强 - 增加LOSS分布、目标达成、管理建议
        // ========================================================================
        // 在原renderReport基础上,增强月度报告的数据维度
        window.renderReport = (function(origRender) {
            return function() {
                origRender();
                // 仅当选中月报时增强
                let rpType = document.getElementById('reportType')?.value;
                if(rpType !== 'month') return;
                // 增加月度目标达成卡片
                let tm = db.targetMgmt;
                if(!tm || !tm.targets) return;
                let month = window.safeDOM.val("globalDate").substring(0,7);
                if(!tm.targets[month]) return;
                let targets = tm.targets[month].lines;
                let [y,mv] = month.split('-').map(Number);
                let daysInMonth = new Date(y,mv,0).getDate();
                // 计算各WS达成
                let wsHtml = '<div class="r-block" id="extra-target-block" style="margin-top:10px;"><div class="r-block-title" style="background:var(--midea-blue); color:white; padding:8px 12px; border-radius:var(--radius) var(--radius) 0 0; font-weight:900; text-align:center;">🎯 月度目标达成分析</div>';
                let totalTarget = 0, totalActual = 0;
                Object.keys(targets).sort().forEach(ws => {
                    let t = targets[ws];
                    let wsActual = 0;
                    Object.keys(db.prod).forEach(d => {
                        if(d.startsWith(month) && db.prod[d] && db.prod[d][ws]) wsActual += Number(db.prod[d][ws].o||0);
                    });
                    let wsTarget = Number(t.dailyTarget||0) * daysInMonth;
                    let rate = wsTarget > 0 ? (wsActual/wsTarget*100) : 0;
                    totalTarget += wsTarget; totalActual += wsActual;
                    let rColor = rate >= 90 ? 'var(--success)' : (rate >= 70 ? 'var(--warning)' : 'var(--danger)');
                    wsHtml += `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-bottom:1px solid var(--border-light);">
                        <span style="font-weight:800;">${ws}</span>
                        <span>${wsActual.toLocaleString()} / ${wsTarget.toLocaleString()}</span>
                        <span style="font-weight:900;color:${rColor};">${rate.toFixed(1)}%</span>
                        <div style="width:100px;height:8px;background:rgba(0,0,0,0.05);border-radius:4px;overflow:hidden;">
                            <div style="height:100%;width:${Math.min(100,rate)}%;background:${rColor};border-radius:4px;"></div>
                        </div>
                    </div>`;
                });
                let totalRate = totalTarget > 0 ? (totalActual/totalTarget*100) : 0;
                wsHtml += `<div style="display:flex;justify-content:space-between;padding:8px 12px;font-weight:900;background:var(--bg-base);border-radius:0 0 8px 8px;">
                    <span>全厂合计</span><span>${totalActual.toLocaleString()} / ${totalTarget.toLocaleString()}</span><span style="color:${totalRate>=90?'var(--success)':'var(--warning)'}">${totalRate.toFixed(1)}%</span>
                </div>`;
                wsHtml += '</div>';
                // 插入到报告顶部
                let reportRows = document.querySelector('.report-rows-container') || document.getElementById('reportCanvasBlock')?.querySelector('.section-sorter') || document.querySelector('#reportCanvasBlock > div');
                if(reportRows) {
                    let existing = document.getElementById('extra-target-block');
                    if(existing) existing.remove();
                    reportRows.insertAdjacentHTML('afterbegin', wsHtml);
                }
                // 自动生成管理建议
                let recBox = document.getElementById('ai-summary-content');
                if(recBox && !recBox.dataset._enhanced) {
                    recBox.dataset._enhanced = '1';
                    let recs = [];
                    if(totalRate < 80) recs.push('⚠️ 全厂目标达成不足80%,建议召开紧急应对会议,调整5月后半段生产计划');
                    if(totalRate >= 80 && totalRate < 95) recs.push('📋 全厂目标接近达成,建议维持当前节奏,重点关注落后产线的日追赶计划');
                    if(totalRate >= 95) recs.push('🎉 全厂目标达成良好,建议总结经验,制定下月挑战目标');
                    // LOSS关联检查
                    let lossTotal = (db.loss||[]).filter(l => l.date && l.date.startsWith(month)).reduce((s,l) => s + Math.abs(Number(l.qty||0)), 0);
                    if(lossTotal > 0) recs.push(`📊 本月LOSS合计 ${lossTotal.toLocaleString()} 件,重点跟进高LOSS产线的根因对策实施`);
                    let unlinkedLossCount = (db.loss||[]).filter(l => l.date && l.date.startsWith(month) && !l.pspId && !l.midId).length;
                    if(unlinkedLossCount > 0) recs.push(`🔗 ${unlinkedLossCount} 个LOSS未关联PSP或事中,建议在月度复盘前完成关联和跟踪状态更新`);
                    // 人员推演建议
                    let sim = db.simConfig;
                    if(sim && sim.lines) {
                        let surplusPeople = 0;
                        sim.lines.forEach(line => {
                            let ws = line.ws;
                            let today = window.safeDOM.val("globalDate");
                            let actualHead = Number(db.prod[today] && db.prod[today][ws] ? db.prod[today][ws].att||0 : 0);
                            let actualOutput = Number(db.prod[today] && db.prod[today][ws] ? db.prod[today][ws].o||0 : 0);
                            let theoreticalNeeded = line.stdTime * actualOutput / (line.workingMin * 60);
                            let diff = actualHead - Math.round(theoreticalNeeded);
                            if(diff > 3) surplusPeople += (diff - 2);
                        });
                        if(surplusPeople > 0) recs.push(`👥 人员推演显示可优化 ${surplusPeople} 人,建议纳入下月度少人化计划`);
                    }
                    // DM开展率
                    let dmCount = 0, dmDone = 0;
                    Object.keys(db.dm||{}).forEach(d => {
                        if(d.startsWith(month)) {
                            Object.keys(db.dm[d]).forEach(ws => {
                                if(ws.startsWith('PRO')) {
                                    dmCount += 2;
                                    dmDone += (db.dm[d][ws].am||0) + (db.dm[d][ws].pm||0);
                                }
                            });
                        }
                    });
                    let dmRate = dmCount > 0 ? (dmDone/dmCount*100) : 0;
                    if(dmRate < 85) recs.push(`📋 DM开展率仅 ${dmRate.toFixed(0)}%,建议加强车间级日常管理会议的常态化执行`);
                    recBox.innerHTML = recs.map(r => `<div style="padding:6px 10px;margin-bottom:4px;background:rgba(25,118,210,0.04);border-left:3px solid var(--midea-blue);border-radius:4px;font-size:12px;">${r}</div>`).join('');
                    recBox.style.display = 'block';
                }
            };
        })(window.renderReport);
function escapeHtml(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

// ================= 🎯 改善项目跟踪模块 =================
window.renderImproveProjects = function() {
    try {
        if (!db.improveProjects) db.improveProjects = [];
        var deptFilter = (document.getElementById('improve-filter-dept') || {}).value || '';
        var statusFilter = (document.getElementById('improve-filter-status') || {}).value || '';
        var startFilter = (document.getElementById('improve-filter-start') || {}).value || '';
        var endFilter = (document.getElementById('improve-filter-end') || {}).value || '';
        var todayStr = new Date().toISOString().split('T')[0];

        // Auto-update overdue status
        db.improveProjects.forEach(function(p) {
            if (p.planEndDate && p.planEndDate < todayStr && p.progress !== '已完成') {
                if (p.progress !== '逾期') {
                    p._origProgress = p.progress || '进行中';
                }
                p.progress = '逾期';
            } else if (p.progress === '逾期' && !(p.planEndDate && p.planEndDate < todayStr)) {
                p.progress = p._origProgress || '进行中';
            }
        });

        var filtered = db.improveProjects.filter(function(p) {
            if (deptFilter && p.dept !== deptFilter) return false;
            if (statusFilter && p.progress !== statusFilter) return false;
            if (startFilter && p.startDate && p.startDate < startFilter) return false;
            if (endFilter && p.startDate && p.startDate > endFilter) return false;
            return true;
        });

        // Sort: group by department (when ALL), then overdue first, then in progress, then completed
        var isGrouped = !deptFilter;
        filtered.sort(function(a, b) {
            if (isGrouped) {
                var deptA = a.dept || '';
                var deptB = b.dept || '';
                if (deptA !== deptB) return deptA.localeCompare(deptB);
            }
            var aScore = a.progress === '逾期' ? 0 : (a.progress === '进行中' ? 1 : (a.progress === '未开始' ? 2 : 3));
            var bScore = b.progress === '逾期' ? 0 : (b.progress === '进行中' ? 1 : (b.progress === '未开始' ? 2 : 3));
            if (aScore !== bScore) return aScore - bScore;
            return (b.startDate || '').localeCompare(a.startDate || '');
        });

        // Stats
        var total = filtered.length;
        var done = filtered.filter(function(p) { return p.progress === '已完成'; }).length;
        var prog = filtered.filter(function(p) { return p.progress === '进行中'; }).length;
        var over = filtered.filter(function(p) { return p.progress === '逾期'; }).length;
        var rate = total > 0 ? Math.round(done / total * 100) : 0;
        document.getElementById('improve-total-count').innerText = total;
        document.getElementById('improve-done-count').innerText = done;
        document.getElementById('improve-prog-count').innerText = prog;
        document.getElementById('improve-over-count').innerText = over;
        document.getElementById('improve-rate').innerText = rate + '%';

        var body = document.getElementById('improve-table-body');
        if (!body) return;

        // Build grouped HTML with department separators when ALL filter
        var bodyHTML = '';
        var lastDept = null;
        filtered.forEach(function(p) {
            if (isGrouped) {
                var curDept = p.dept || t('improve_opt_select');
                if (curDept !== lastDept) {
                    lastDept = curDept;
                    bodyHTML += '<tr style="background:linear-gradient(90deg,#dbeafe,#eff6ff);"><td colspan="7" style="padding:4px 10px;font-weight:800;font-size:13px;color:#1d4ed8;border-bottom:2px solid #bfdbfe;"><i class="fa-solid fa-layer-group" style="margin-right:5px;"></i>' + curDept + '</td></tr>';
                }
            }
            var isOverdue = p.progress === '逾期';
            var rowBg = isOverdue ? 'style="background:#fef2f2;"' : '';
            var effectiveProgress = p.progress;
            if (p.progress === '逾期') {
                effectiveProgress = p._origProgress || '进行中';
            }
            var isOverdueCheck = p.progress === '逾期';
            var overdueFlag = isOverdueCheck ? ' <span style="color:#dc2626;font-weight:900;font-size:10px;">\u26a0\ufe0f</span>' : '';
            var selectStyle = isOverdueCheck ? 'border:1px solid #fecaca;background:#fef2f2;' : 'border:none;background:transparent;';

            bodyHTML += '<tr ' + rowBg + '>' +
                '<td style="padding:4px 8px;"><input type="date" value="' + (p.startDate || '') + '" onchange="updateImproveField(\'' + p.id + '\',\'startDate\',this.value)" style="width:100%;border:none;font-size:12px;background:transparent;font-weight:600;"></td>' +
                '<td style="padding:4px 8px;"><input value="' + escapeHtml(p.projectName || '') + '" onchange="updateImproveField(\'' + p.id + '\',\'projectName\',this.value)" placeholder="' + t('improve_placeholder_name') + '" style="width:100%;border:none;font-size:13px;font-weight:700;background:transparent;"></td>' +
                '<td style="padding:4px 8px;"><select onchange="updateImproveField(\'' + p.id + '\',\'dept\',this.value)" style="width:100%;border:none;font-size:12px;font-weight:600;background:transparent;">' +
                    DEPTS.map(function(d) { return '<option ' + (p.dept === d ? 'selected' : '') + '>' + d + '</option>'; }).join('') +
                    '<option ' + ((!p.dept || DEPTS.indexOf(p.dept) === -1) ? 'selected' : '') + ' value="">' + t('improve_opt_select') + '</option>' +
                '</select></td>' +
                '<td style="padding:4px 8px;text-align:center;">' +
                    '<select onchange="updateImproveField(\'' + p.id + '\',\'progress\',this.value)" style="width:100%;font-size:12px;font-weight:600;cursor:pointer;' + selectStyle + 'padding:2px 4px;border-radius:4px;">' +
                        '<option value="未开始" ' + (effectiveProgress === '未开始' ? 'selected' : '') + '>' + t('improve_status_notstart') + '</option>' +
                        '<option value="进行中" ' + (effectiveProgress === '进行中' ? 'selected' : '') + '>' + t('improve_status_prog') + '</option>' +
                        '<option value="已完成" ' + (effectiveProgress === '已完成' ? 'selected' : '') + '>' + t('improve_status_done') + '</option>' +
                    '</select>' +
                    overdueFlag +
                '</td>' +
                '<td style="padding:4px 8px;"><input value="' + escapeHtml(p.progressDesc || '') + '" onchange="updateImproveField(\'' + p.id + '\',\'progressDesc\',this.value)" placeholder="' + t('improve_placeholder_desc') + '" style="width:100%;border:none;font-size:12px;background:transparent;"></td>' +
                '<td style="padding:4px 8px;"><input type="date" value="' + (p.planEndDate || '') + '" onchange="updateImproveField(\'' + p.id + '\',\'planEndDate\',this.value)" style="width:100%;border:none;font-size:12px;background:transparent;font-weight:600;' + (isOverdue ? 'color:#dc2626;' : '') + '"></td>' +
                '<td style="padding:4px 8px;text-align:center;"><i class="fa-solid fa-xmark" style="color:var(--danger);cursor:pointer;font-size:16px;" onclick="delImproveProject(\'' + p.id + '\')"></i></td>' +
                '</tr>';
        });
        bodyHTML = bodyHTML || '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;font-size:14px;"><i class="fa-solid fa-inbox" style="font-size:24px;display:block;margin-bottom:8px;"></i>' + t('improve_empty') + '</td></tr>';
        body.innerHTML = bodyHTML;
    } catch(e) { console.error('[改善项目跟踪] render error:', e.message); }
};

window.addImproveProject = function() {
    if (!db.improveProjects) db.improveProjects = [];
    var today = new Date().toISOString().split('T')[0];
    db.improveProjects.unshift({
        id: Date.now() + '-' + Math.random().toString(36).substring(2, 8),
        startDate: today,
        projectName: '',
        dept: '',
        progress: '未开始',
        progressDesc: '',
        planEndDate: ''
    });
    triggerAutoSave();
    renderImproveProjects();
    populateImproveDeptFilter();
    showToast('fa-solid fa-plus-circle', t('improve_add_done'));
};

window.updateImproveField = function(id, field, value) {
    var p = (db.improveProjects || []).find(function(item) { return String(item.id) === String(id); });
    if (!p) return console.warn('[改善项目] 未找到:', id);
    p[field] = value;
    // Auto-update overdue status
    var todayStr = new Date().toISOString().split('T')[0];
    if (field === 'planEndDate' || field === 'progress') {
        // Save original progress before auto-overdue
        if (field === 'progress') {
            p._origProgress = value;
        }
        if (p.planEndDate && p.planEndDate < todayStr && p.progress !== '已完成') {
            if (p.progress !== '逾期') {
                p._origProgress = p._origProgress || p.progress || '进行中';
            }
            p.progress = '逾期';
        } else if (p.progress === '逾期' && !(p.planEndDate && p.planEndDate < todayStr)) {
            p.progress = p._origProgress || '进行中';
        }
    }
    triggerAutoSave();
    renderImproveProjects();
};

window.delImproveProject = function(id) {
    if (!db.improveProjects) return;
    if (!confirm(t('improve_confirm_del'))) return;
    db.improveProjects = db.improveProjects.filter(function(p) { return String(p.id) !== String(id); });
    _deferredLocalStorageSave();
    setTimeout(function() {
        if (typeof forceSaveToFirebase === 'function') { forceSaveToFirebase().catch(function(){}); } else { triggerAutoSave(); }
    }, 0);
    renderImproveProjects();
    populateImproveDeptFilter();
    showToast('fa-solid fa-check', t('improve_del_done'));
};

window.quickImproveDateRange = function() {
    var now = new Date();
    var firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    var startEl = document.getElementById('improve-filter-start');
    var endEl = document.getElementById('improve-filter-end');
    if (startEl) startEl.value = firstDay.toISOString().split('T')[0];
    if (endEl) endEl.value = now.toISOString().split('T')[0];
    renderImproveProjects();
};

function populateImproveDeptFilter() {
    var sel = document.getElementById('improve-filter-dept');
    if (!sel) return;
    var currentVal = sel.value;
    var depts = {};
    (db.improveProjects || []).forEach(function(p) { if (p.dept) depts[p.dept] = true; });
    sel.innerHTML = '<option value="">' + t('improve_opt_all') + '</option>' +
        Object.keys(depts).sort().map(function(d) { return '<option ' + (currentVal === d ? 'selected' : '') + '>' + d + '</option>'; }).join('');
    if (!Object.keys(depts).length) {
        DEPTS.forEach(function(d) { sel.innerHTML += '<option>' + d + '</option>'; });
    }
    sel.value = currentVal;
}

// ================= 🎨 改善项目海报生成（类似PSP海报） =================
window.generateImprovePoster = function() {
    try {
        var items = db.improveProjects || [];
        if (items.length === 0) {
            showToast('fa-solid fa-info-circle', t('improve_not_found'));
            return;
        }
        var todayStr = new Date().toISOString().split('T')[0];

        // Recalculate overdue
        items.forEach(function(p) {
            if (p.planEndDate && p.planEndDate < todayStr && p.progress !== '已完成') {
                if (p.progress !== '逾期') {
                    p._origProgress = p.progress || '进行中';
                }
                p.progress = '逾期';
            } else if (p.progress === '逾期' && !(p.planEndDate && p.planEndDate < todayStr)) {
                p.progress = p._origProgress || '进行中';
            }
        });

        // Sort: overdue first
        var sorted = items.slice().sort(function(a, b) {
            var aOv = a.progress === '逾期' ? 0 : (a.progress === '进行中' ? 1 : (a.progress === '未开始' ? 2 : 3));
            var bOv = b.progress === '逾期' ? 0 : (b.progress === '进行中' ? 1 : (b.progress === '未开始' ? 2 : 3));
            return aOv - bOv;
        });

        // Stats
        var total = items.length;
        var done = items.filter(function(p) { return p.progress === '已完成'; }).length;
        var prog = items.filter(function(p) { return p.progress === '进行中'; }).length;
        var over = items.filter(function(p) { return p.progress === '逾期'; }).length;
        var rate = total > 0 ? Math.round(done / total * 100) : 0;

        var h = '<div class="psp-poster">';
        h += '<div class="psp-poster-hdr">';
        h += '<div class="psp-poster-title">\uD83C\uDFAF 改善项目跟踪通报<div class="bi-en-title">Improvement Project Tracking Report</div></div>';
        h += '<div class="psp-poster-period">生成时间: ' + new Date().toLocaleString('zh-CN', {hour12:false}) + '<br><span class="bi-en-sub">Generated: ' + new Date().toLocaleString('en-US', {hour12:false}) + '</span></div>';
        h += '</div>';

        // Summary bar
        h += '<div class="psp-poster-summary-bar">';
        h += '<div class="psp-ps-item"><b>' + total + '</b><span class="bi-cn">项目总数</span><span class="bi-en">Total Projects</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#16a34a;">' + done + '</b><span class="bi-cn">已完成</span><span class="bi-en">Completed</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#ea580c;">' + prog + '</b><span class="bi-cn">进行中</span><span class="bi-en">In Progress</span></div>';
        h += '<div class="psp-ps-item" style="background:#fef2f2;"><b style="color:#dc2626;font-size:22px;">' + over + '</b><span class="bi-cn" style="color:#dc2626;">已逾期</span><span class="bi-en" style="color:#dc2626;">Overdue</span></div>';
        h += '<div class="psp-ps-item"><b style="color:#1e40af;">' + rate + '%</b><span class="bi-cn">完成率</span><span class="bi-en">Completion Rate</span></div>';
        h += '</div>';

        // ===== 各部门完成率排名 =====
        var deptStats = {};
        items.forEach(function(p) {
            var d = p.dept || '其他';
            if (!deptStats[d]) deptStats[d] = { total:0, done:0, prog:0, over:0, notstart:0 };
            deptStats[d].total++;
            if (p.progress === '已完成') deptStats[d].done++;
            else if (p.progress === '逾期') deptStats[d].over++;
            else if (p.progress === '进行中') deptStats[d].prog++;
            else deptStats[d].notstart++;
        });
        var deptRanking = Object.keys(deptStats).map(function(d) {
            var s = deptStats[d];
            return { dept: d, total: s.total, done: s.done, prog: s.prog, over: s.over, notstart: s.notstart, rate: s.total > 0 ? Math.round(s.done / s.total * 100) : 0 };
        }).sort(function(a, b) {
            if (a.rate !== b.rate) return b.rate - a.rate;
            return b.total - a.total;
        });

        h += '<div style="margin:12px 0 8px;padding:10px 12px;background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border-radius:8px;border:1px solid #bae6fd;">';
        h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">';
        h += '<span style="font-size:16px;">\uD83C\uDFC6</span>';
        h += '<span style="font-weight:900;font-size:14px;color:#0369a1;">各部门改善完成率排名</span>';
        h += '<span style="font-size:10px;color:#64748b;font-weight:400;">Department Completion Rate Ranking</span>';
        h += '</div>';
        h += '<table style="width:100%;border-collapse:collapse;font-size:11px;">';
        h += '<thead><tr>';
        h += '<th style="width:32px;padding:3px 4px;background:#0284c7;color:#fff;font-size:10px;font-weight:700;text-align:center;border-radius:4px 0 0 0;">#</th>';
        h += '<th style="padding:3px 6px;background:#0284c7;color:#fff;font-size:11px;font-weight:800;text-align:left;"><span style="display:block;line-height:1.2;">\u90E8\u95E8</span><span style="display:block;font-size:8px;font-weight:400;opacity:0.8;">Dept</span></th>';
        h += '<th style="width:38px;padding:3px 4px;background:#0284c7;color:#fff;font-size:10px;font-weight:700;text-align:center;"><span style="display:block;">\u603B</span><span style="display:block;font-size:8px;font-weight:400;opacity:0.8;">Total</span></th>';
        h += '<th style="width:38px;padding:3px 4px;background:#0284c7;color:#fff;font-size:10px;font-weight:700;text-align:center;"><span style="display:block;color:#86efac;">\u2713</span><span style="display:block;font-size:8px;font-weight:400;opacity:0.8;">Done</span></th>';
        h += '<th style="width:36px;padding:3px 4px;background:#0284c7;color:#fff;font-size:10px;font-weight:700;text-align:center;"><span style="display:block;color:#fcd34d;">\u26A0</span><span style="display:block;font-size:8px;font-weight:400;opacity:0.8;">Over</span></th>';
        h += '<th style="width:50px;padding:3px 4px;background:#0284c7;color:#fff;font-size:10px;font-weight:700;text-align:center;"><span style="display:block;">\u5B8C\u6210\u7387</span><span style="display:block;font-size:8px;font-weight:400;opacity:0.8;">Rate</span></th>';
        h += '<th style="padding:3px 6px;background:#0284c7;color:#fff;font-size:10px;font-weight:700;text-align:left;border-radius:0 4px 0 0;"><span style="display:block;">\u8FDB\u5EA6\u6761</span><span style="display:block;font-size:8px;font-weight:400;opacity:0.8;">Progress Bar</span></th>';
        h += '</tr></thead><tbody>';

        deptRanking.forEach(function(d, idx) {
            var medal = '';
            if (idx === 0 && d.rate > 0) medal = '\uD83E\uDD47';
            else if (idx === 1 && d.rate > 0) medal = '\uD83E\uDD48';
            else if (idx === 2 && d.rate > 0) medal = '\uD83E\uDD49';
            var barColor = d.rate >= 80 ? '#16a34a' : (d.rate >= 50 ? '#ea580c' : '#dc2626');
            var barBg = d.rate >= 80 ? '#dcfce7' : (d.rate >= 50 ? '#fed7aa' : '#fecaca');
            var rowBg = idx % 2 === 0 ? 'background:#f0f9ff;' : 'background:#fff;';
            h += '<tr style="' + rowBg + '">';
            h += '<td style="padding:3px 4px;text-align:center;font-weight:800;font-size:13px;border-bottom:1px solid #e2e8f0;">' + (medal || '<span style="color:#94a3b8;font-size:10px;">' + (idx + 1) + '</span>') + '</td>';
            h += '<td style="padding:3px 6px;text-align:left;font-weight:700;font-size:12px;border-bottom:1px solid #e2e8f0;">' + d.dept + '</td>';
            h += '<td style="padding:3px 4px;text-align:center;font-weight:700;border-bottom:1px solid #e2e8f0;">' + d.total + '</td>';
            h += '<td style="padding:3px 4px;text-align:center;font-weight:700;color:#16a34a;border-bottom:1px solid #e2e8f0;">' + d.done + '</td>';
            h += '<td style="padding:3px 4px;text-align:center;font-weight:700;color:' + (d.over > 0 ? '#dc2626' : '#94a3b8') + ';border-bottom:1px solid #e2e8f0;">' + d.over + '</td>';
            h += '<td style="padding:3px 4px;text-align:center;font-weight:900;font-size:13px;color:' + barColor + ';border-bottom:1px solid #e2e8f0;">' + d.rate + '%</td>';
            h += '<td style="padding:3px 6px;border-bottom:1px solid #e2e8f0;"><div style="height:14px;background:' + barBg + ';border-radius:7px;overflow:hidden;position:relative;"><div style="height:100%;width:' + d.rate + '%;background:linear-gradient(90deg,' + barColor + ',' + (d.rate >= 80 ? '#22c55e' : (d.rate >= 50 ? '#f97316' : '#ef4444')) + ');border-radius:7px;transition:width 0.3s;"></div></div></td>';
            h += '</tr>';
        });

        h += '</tbody></table>';
        h += '</div>';

        // Table
        h += '<table class="psp-poster-table">';
        h += '<thead><tr>';
        h += '<th style="width:95px;"><div class="bi-th-cn">立项时间</div><div class="bi-th-en">Start Date</div></th>';
        h += '<th style="min-width:160px;"><div class="bi-th-cn">项目名称</div><div class="bi-th-en">Project Name</div></th>';
        h += '<th style="width:85px;"><div class="bi-th-cn">责任部门</div><div class="bi-th-en">Dept</div></th>';
        h += '<th style="width:70px;"><div class="bi-th-cn">进度</div><div class="bi-th-en">Status</div></th>';
        h += '<th style="min-width:140px;"><div class="bi-th-cn">进度描述</div><div class="bi-th-en">Description</div></th>';
        h += '<th style="width:105px;"><div class="bi-th-cn">计划完成时间</div><div class="bi-th-en">Due Date</div></th>';
        h += '<th style="width:85px;"><div class="bi-th-cn">逾期标记</div><div class="bi-th-en">Overdue Flag</div></th>';
        h += '</tr></thead><tbody>';

        for (var i = 0; i < sorted.length; i++) {
            var p = sorted[i];
            var isOverdue = p.progress === '逾期';
            var rowBg = isOverdue ? 'background:#fef2f2;' : '';
            var statusColor = p.progress === '已完成' ? 'color:#16a34a;font-weight:800;' : (p.progress === '进行中' ? 'color:#ea580c;font-weight:800;' : (p.progress === '未开始' ? 'color:#64748b;font-weight:800;' : 'color:#dc2626;font-weight:900;'));
            var statusCN = p.progress === '已完成' ? '已完成' : (p.progress === '进行中' ? '进行中' : (p.progress === '未开始' ? '未开始' : '逾期'));
            var statusEN = p.progress === '已完成' ? 'Completed' : (p.progress === '进行中' ? 'In Progress' : (p.progress === '未开始' ? 'Not Started' : 'Overdue'));

            h += '<tr style="' + rowBg + '">';
            h += '<td>' + (p.startDate || '') + '</td>';
            h += '<td style="text-align:left;word-break:break-word;font-size:13px;font-weight:700;padding:5px 8px;">' + escapeHtml(p.projectName || '') + '</td>';
            h += '<td>' + (p.dept || '') + '</td>';
            h += '<td style="' + statusColor + '"><span class="bi-cn" style="font-size:13px;font-weight:900;">' + statusCN + '</span><span class="bi-en" style="font-size:10px;font-weight:600;">' + statusEN + '</span></td>';
            h += '<td style="text-align:left;font-size:12px;padding:5px 8px;">' + escapeHtml(p.progressDesc || '') + '</td>';
            h += '<td' + (isOverdue ? ' style="font-weight:900;color:#dc2626;"' : '') + '>' + (p.planEndDate || '') + '</td>';
            h += '<td>' + (isOverdue ? '<div style="background:#dc2626;color:#fff;font-weight:900;font-size:15px;padding:3px 8px;border-radius:4px;text-align:center;"><span class="bi-cn">\u26A0\uFE0F 已逾期</span><br><span class="bi-en" style="color:#fff;font-size:10px;">Overdue</span></div>' : '') + '</td>';
            h += '</tr>';
        }

        h += '</tbody></table>';

        // Footer
        h += '<div class="psp-poster-footer">';
        h += '逾期说明:计划完成时间已过但未完成的项目标记为红色「已逾期」，请责任部门尽快确认并推进。<br>';
        h += '<span class="bi-en-foot">Note: Items past due date and not completed are marked in red as "Overdue". Please confirm and take action ASAP.</span>';
        h += '</div>';
        h += '</div>';

        // Open new window
        var win = window.open('', '_blank');
        if (!win) {
            showToast('fa-solid fa-warning', '请允许弹窗以导出海报', 'error');
            return;
        }

        var styles = document.querySelectorAll('style, link[rel="stylesheet"]');
        var styleHTML = '';
        for (var si = 0; si < styles.length; si++) styleHTML += styles[si].outerHTML;

        win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>改善项目跟踪通报 | Improvement Project Tracking Report</title>');
        win.document.write(styleHTML);
        win.document.write('<style>' +
            'body{margin:0;padding:8px;background:#f8fafc;font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:12px;}' +
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

        showToast('fa-solid fa-file-image', '已生成改善项目通报,可在新窗口打印/另存为PDF');
        setTimeout(function() {
            win.focus();
            win.print();
        }, 500);

    } catch(e) {
        console.error('[改善项目海报] 生成失败:', e.message, e.stack);
        showToast('fa-solid fa-xmark', '海报生成失败: ' + e.message, 'error');
    }
};

// ================= 📊 改善项目导出Excel =================
window.exportImproveToExcel = function() {
    if (!db.improveProjects || db.improveProjects.length === 0) {
        showToast('fa-solid fa-info-circle', '暂无改善项目记录', 'warning');
        return;
    }
    try {
        var sorted = db.improveProjects.slice().sort(function(a, b) { return (b.startDate || '').localeCompare(a.startDate || ''); });
        var xlsData = sorted.map(function(r, idx) {
            return {
                '序号': idx + 1,
                '立项时间': r.startDate || '',
                '项目名称': r.projectName || '',
                '责任部门': r.dept || '',
                '进度': r.progress || '',
                '进度描述': r.progressDesc || '',
                '计划完成时间': r.planEndDate || ''
            };
        });
        if (typeof XLSX !== 'undefined') {
            var ws = XLSX.utils.json_to_sheet(xlsData);
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '改善项目');
            XLSX.writeFile(wb, '改善项目跟踪_' + new Date().toISOString().split('T')[0] + '.xlsx');
            showToast('fa-solid fa-check', '已导出 ' + xlsData.length + ' 条改善项目数据');
        } else {
            showToast('fa-solid fa-warning', 'XLSX库未加载，请稍后重试', 'error');
        }
    } catch(e) {
        console.error('[改善项目] 导出失败:', e.message);
        showToast('fa-solid fa-xmark', '导出失败: ' + e.message, 'error');
    }
};

// ================= 🔄 Hook into page switching =================
// Patch showPage to auto-render improve projects when switching to p-improve-track
(function() {
    var origShowPage = window.showPage;
    if (origShowPage) {
        window.showPage = function(id, btn) {
            origShowPage.call(this, id, btn);
            if (id === 'p-improve-track') {
                setTimeout(function() {
                    // Recalc overdue status
                    var todayStr = new Date().toISOString().split('T')[0];
                    (db.improveProjects || []).forEach(function(p) {
                        if (p.planEndDate && p.planEndDate < todayStr && p.progress !== '已完成') {
                            if (p.progress !== '逾期') {
                                p._origProgress = p.progress || '进行中';
                            }
                            p.progress = '逾期';
                        } else if (p.progress === '逾期' && !(p.planEndDate && p.planEndDate < todayStr)) {
                            p.progress = p._origProgress || '进行中';
                        }
                    });
                    // Populate dept filter from existing data + DEPTS
                    populateImproveDeptFilter();
                    renderImproveProjects();
                }, 50);
            }
        };
    }
})();
