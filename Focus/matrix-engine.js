// matrix-engine.js  — FocusOS v2 (Treadmill-Effect Fix + Pull-Forward support)
const MatrixEngine = {
    config: { cl_chapter: 5.0, cl_lecture: 2.5, cl_mcq: 0.15, cl_custom: 2.0, max_safe_cl: 20.0 },

    // Universal palette — keep in sync with habits.html / planner.html
    SUBJECT_COLORS: ['#6ba4ed', '#ff6b81', '#10b981', '#f59e0b', '#8a65e8', '#0ea5e9', '#ec407a', '#f43f5e', '#8b5cf6', '#14b8a6'],
    CUSTOM_OP_COLOR: '#FFB86B',

    setConfig: function (newConfig) {
        if (newConfig) this.config = { ...this.config, ...newConfig };
    },

    calculateCognitiveLoad: function (unitType, count) {
        let w = 1.0;
        if (unitType === 'Chapters' || unitType === 'Ch.')  w = this.config.cl_chapter;
        else if (unitType === 'Lectures' || unitType === 'Lec.') w = this.config.cl_lecture;
        else if (unitType === 'MCQs') w = this.config.cl_mcq;
        return count * w;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: does a custom-op fall on the given calendar date?
    // ─────────────────────────────────────────────────────────────────────────
    _customOpMatchesDay: function (op, loopDate) {
        let opTimestamp = parseInt(op.target_date || op.date || 0);
        let pattern = op.repeat_pattern || op.repeatPattern || null;
        if (pattern && Array.isArray(pattern) && pattern.length > 0) {
            let startMidnight = new Date(opTimestamp); startMidnight.setHours(0,0,0,0);
            return loopDate.getTime() >= startMidnight.getTime() && pattern.includes(loopDate.getDay());
        }
        let opMidnight = new Date(opTimestamp); opMidnight.setHours(0,0,0,0);
        return loopDate.getTime() === opMidnight.getTime();
    },

    // ─────────────────────────────────────────────────────────────────────────
    // FIX 3 — Treadmill-Effect Kill
    //
    // The root cause: the engine was using task.completed_work as the GLOBAL
    // progress counter but then also counting completions recorded in appData
    // for today.  That double-counted today's work, so when you completed a
    // unit the engine thought 0 units remained for today AND pulled forward
    // from tomorrow — the endless treadmill.
    //
    // The correct approach:
    //   remainingForSpread = total_work - completed_work_BEFORE_today
    //
    // "completed_work_before_today" = completed_work minus however many units
    // were recorded in appData on today's date.  This way the engine always
    // sees exactly the right number of units left to place on the calendar,
    // without treating today's completions as extra available slots.
    //
    // _getCompletedTodayForTask() extracts that per-task count from appData.
    // ─────────────────────────────────────────────────────────────────────────
    _getCompletedTodayForTask: function (taskId, appData, today) {
        const yr = today.getFullYear(), mo = today.getMonth(), dy = today.getDate();
        const dayData = (appData[yr] && appData[yr][mo] && appData[yr][mo][dy]) ? appData[yr][mo][dy] : {};
        let val = dayData[taskId];
        if (!val) return 0;
        return (typeof val === 'boolean') ? (val ? 1 : 0) : val;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Spent-capacity seeder for projectedCL[0]
    // (unchanged logic — kept for the bar-chart anchor)
    // ─────────────────────────────────────────────────────────────────────────
    _calculateSpentCapacity: function (activeTasks, customOpsData, memoryLog, appData, today) {
        const yr = today.getFullYear(), mo = today.getMonth(), dy = today.getDate();
        const dayData = (appData[yr] && appData[yr][mo] && appData[yr][mo][dy]) ? appData[yr][mo][dy] : {};
        let spentCL = 0;

        activeTasks.forEach(task => {
            let val = dayData[task.id];
            if (!val) return;
            let done = (typeof val === 'boolean') ? (val ? 1 : 0) : val;
            if (done > 0) spentCL += this.calculateCognitiveLoad(task.unit, done);
        });

        (memoryLog || []).forEach(m => {
            if (dayData['rev_' + m.id]) spentCL += 0.5;
        });

        (customOpsData || []).forEach(op => {
            if (op.is_oracle_gen === true) return;
            if (dayData['cust_' + op.id]) spentCL += this.config.cl_custom;
        });

        return spentCL;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Main timeline analyzer
    // ─────────────────────────────────────────────────────────────────────────
    analyzeTimelines: function (activeTasks, memoryLog, customOpsData, appData, todayDate) {
        const today = new Date(todayDate); today.setHours(0,0,0,0);

        let totalActive = 0, totalDebt = 0;
        let missionsReq = 0, missionsDone = 0;
        let chartDatasets = [];

        // Seed projectedCL[0] with already-burned capacity so the engine won't
        // pull tomorrow's work into today after completions (Treadmill Fix).
        let spentCapacityToday = this._calculateSpentCapacity(activeTasks, customOpsData, memoryLog, appData, today);
        let projectedCL = new Array(30).fill(0);
        projectedCL[0] = spentCapacityToday;

        let uniqueSubjects = [...new Set((activeTasks || []).map(t => t.subject))].sort();

        const yr0 = today.getFullYear(), mo0 = today.getMonth(), dy0 = today.getDate();
        const todayData = (appData[yr0] && appData[yr0][mo0] && appData[yr0][mo0][dy0]) ? appData[yr0][mo0][dy0] : {};

        // ── Memory reviews ───────────────────────────────────────────────────
        let memoryDueCount = 0;
        (memoryLog || []).forEach(m => {
            if (m.nextReviewDate <= today.getTime()) {
                memoryDueCount++;
                if (!todayData['rev_' + m.id]) projectedCL[0] += 0.5;
            }
        });
        missionsReq += memoryDueCount;

        // ── Custom / protocol operations ─────────────────────────────────────
        let customDailyCount = new Array(30).fill(0);
        (customOpsData || []).forEach(op => {
            let pattern = op.repeat_pattern || op.repeatPattern || null;
            let isOneOff = !pattern || !Array.isArray(pattern) || pattern.length === 0;
            if (isOneOff && (op.is_done === true || op.done === true)) return;
            const isOracleFragment = op.is_oracle_gen === true;
            const effectiveCL = isOracleFragment ? 0 : this.config.cl_custom;

            for (let d = 0; d < 30; d++) {
                let loopDate = new Date(today); loopDate.setDate(today.getDate() + d);
                if (this._customOpMatchesDay(op, loopDate)) {
                    if (!isOneOff) {
                        let lyr = loopDate.getFullYear(), lmo = loopDate.getMonth(), ldy = loopDate.getDate();
                        let alreadyDone = appData[lyr] && appData[lyr][lmo] && appData[lyr][lmo][ldy] && appData[lyr][lmo][ldy]['cust_' + op.id];
                        if (alreadyDone) continue;
                    }
                    if (!isOracleFragment) { projectedCL[d] += effectiveCL; customDailyCount[d]++; }
                    if (d === 0 && !isOracleFragment) {
                        missionsReq++;
                        if (!isOneOff) {
                            if (todayData['cust_' + op.id]) missionsDone++;
                        } else {
                            if (op.is_done === true || op.done === true) missionsDone++;
                        }
                    }
                }
            }
        });

        let customSpread7 = customDailyCount.slice(0, 7).map(c => c * this.config.cl_custom);
        if (customSpread7.some(v => v > 0)) {
            chartDatasets.push({
                label: 'Manual Ops', data: customSpread7,
                backgroundColor: this.CUSTOM_OP_COLOR, borderWidth: 2, borderRadius: 4, borderSkipped: false,
                _tooltipData: customDailyCount.slice(0, 7).map(c => c > 0 ? `${c} custom operation${c > 1 ? 's' : ''}` : '')
            });
        }

        // ── Algorithmic study tasks ──────────────────────────────────────────
        let debtTasks = [], sprintTasks = [], marathonTasks = [];
        let taskSpread = {};

        (activeTasks || []).forEach(task => {
            // ─── TREADMILL FIX ───────────────────────────────────────────────
            // Use total_work minus HISTORICAL completions (i.e. before today).
            // Today's completions are already seeded into projectedCL[0] above,
            // so they must NOT reduce the spread-remaining count — otherwise the
            // engine sees fewer units left and pulls tomorrow's work into today.
            let completedToday = this._getCompletedTodayForTask(task.id, appData, today);
            let historicalCompleted = Math.max(0, (task.completed_work || 0) - completedToday);
            let remain = (task.total_work || 1) - historicalCompleted;
            // ─────────────────────────────────────────────────────────────────

            if (remain <= 0) return;
            totalActive++;

            let deadlineStr = task.deadline.split('T')[0];
            let [y, m, d] = deadlineStr.split('-');
            let deadline = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
            let daysLeft = Math.round((deadline.getTime() - today.getTime()) / 86400000);

            task._remain = remain;
            task._unitWeight = this.calculateCognitiveLoad(task.unit, 1);
            task._daysLeft = daysLeft;
            taskSpread[task.id] = new Array(30).fill(0);

            if (daysLeft < 0) { debtTasks.push(task); totalDebt++; }
            else {
                let wtr = remain / (daysLeft === 0 ? 1 : daysLeft);
                if (wtr < 1.0 && daysLeft > 1) marathonTasks.push(task);
                else sprintTasks.push(task);
            }
        });

        let drifts = [];
        let bottleneckSubject = 'Unknown', bottleneckCL = 0;

        // Strategy: BREACH (debt)
        debtTasks.sort((a, b) => b.priority - a.priority);
        debtTasks.forEach(task => {
            for (let i = 0; i < task._remain; i++) {
                let bestDay = -1;
                for (let d = 0; d < 30; d++) { if (projectedCL[d] + task._unitWeight <= this.config.max_safe_cl) { bestDay = d; break; } }
                if (bestDay === -1) { let low = 9999; for (let d = 0; d < 14; d++) { if (projectedCL[d] < low) { low = projectedCL[d]; bestDay = d; } } }
                projectedCL[bestDay] += task._unitWeight;
                taskSpread[task.id][bestDay]++;
            }
        });

        // Strategy: SPRINT
        sprintTasks.sort((a, b) => a._daysLeft !== b._daysLeft ? a._daysLeft - b._daysLeft : b.priority - a.priority);
        sprintTasks.forEach(task => {
            let maxDayUsed = 0;
            let daysLeft = Math.max(1, task._daysLeft + 1);
            for (let i = 0; i < task._remain; i++) {
                let bestDay = -1;
                for (let d = 0; d < daysLeft; d++) { if (projectedCL[d] + task._unitWeight <= this.config.max_safe_cl) { bestDay = d; break; } }
                if (bestDay === -1) {
                    if (task.is_locked) {
                        let low = 9999; for (let d = 0; d < daysLeft; d++) { if (projectedCL[d] < low) { low = projectedCL[d]; bestDay = d; } }
                    } else {
                        let simDay = daysLeft;
                        for (let d = daysLeft; d < 30; d++) { if (projectedCL[d] + task._unitWeight <= this.config.max_safe_cl) { simDay = d; break; } }
                        if (simDay > maxDayUsed) maxDayUsed = simDay;
                        let low = 9999; for (let d = 0; d < daysLeft; d++) { if (projectedCL[d] < low) { low = projectedCL[d]; bestDay = d; } }
                        if (bestDay === -1) bestDay = 0;
                    }
                }
                projectedCL[bestDay] += task._unitWeight;
                taskSpread[task.id][bestDay]++;
                if (bestDay > maxDayUsed) maxDayUsed = bestDay;
            }
            if (!task.is_locked && maxDayUsed >= daysLeft) drifts.push({ id: task.id, subject: task.subject, newDays: maxDayUsed });
        });

        // Strategy: MARATHON
        marathonTasks.sort((a, b) => b.priority - a.priority);
        marathonTasks.forEach(task => {
            let maxDayUsed = 0;
            let daysLeft = Math.max(1, task._daysLeft + 1);
            for (let i = 0; i < task._remain; i++) {
                let bestDay = -1, lowestApparent = 9999;
                for (let d = 0; d < daysLeft; d++) {
                    let skew = 0;
                    if (task.priority === 5) skew = d * 0.5;
                    if (task.priority === 1) skew = (daysLeft - d) * 0.5;
                    let apparent = projectedCL[d] + skew;
                    if (apparent < lowestApparent && projectedCL[d] + task._unitWeight <= this.config.max_safe_cl) { lowestApparent = apparent; bestDay = d; }
                }
                if (bestDay === -1) {
                    if (task.is_locked) {
                        let low = 9999; for (let d = 0; d < daysLeft; d++) { if (projectedCL[d] < low) { low = projectedCL[d]; bestDay = d; } }
                    } else {
                        let simDay = daysLeft;
                        for (let d = daysLeft; d < 30; d++) { if (projectedCL[d] + task._unitWeight <= this.config.max_safe_cl) { simDay = d; break; } }
                        if (simDay > maxDayUsed) maxDayUsed = simDay;
                        let low = 9999; for (let d = 0; d < daysLeft; d++) { if (projectedCL[d] < low) { low = projectedCL[d]; bestDay = d; } }
                        if (bestDay === -1) bestDay = 0;
                    }
                }
                projectedCL[bestDay] += task._unitWeight;
                taskSpread[task.id][bestDay]++;
                if (bestDay > maxDayUsed) maxDayUsed = bestDay;
            }
            if (!task.is_locked && maxDayUsed >= daysLeft) drifts.push({ id: task.id, subject: task.subject, newDays: maxDayUsed });
        });

        // ── Compile chart datasets ────────────────────────────────────────────
        [...debtTasks, ...sprintTasks, ...marathonTasks].forEach(task => {
            let spreadArray = taskSpread[task.id].slice(0, 7).map(u => this.calculateCognitiveLoad(task.unit, u));
            let cumulative = task.completed_work || 0;
            let tooltipStrings = [];
            for (let i = 0; i < 7; i++) {
                let u = taskSpread[task.id][i];
                if (u > 0) {
                    let s = cumulative + 1, e = cumulative + u;
                    tooltipStrings.push(`${u} ${task.unit} (Part ${s === e ? s : s + '-' + e} of ${task.total_work})`);
                    cumulative += u;
                } else { tooltipStrings.push(''); }
            }
            let subjectIdx = uniqueSubjects.indexOf(task.subject);
            let taskColor = this.SUBJECT_COLORS[subjectIdx % this.SUBJECT_COLORS.length];
            chartDatasets.push({
                label: task.subject, data: spreadArray,
                backgroundColor: taskColor, borderWidth: 2, borderRadius: 4, borderSkipped: false,
                _tooltipData: tooltipStrings
            });

            if (taskSpread[task.id][0] > 0) {
                missionsReq += taskSpread[task.id][0];
                if (todayData[task.id]) {
                    let val = todayData[task.id];
                    missionsDone += (typeof val === 'boolean') ? (val ? 1 : 0) : val;
                }
                let todaysCL = this.calculateCognitiveLoad(task.unit, taskSpread[task.id][0]);
                if (todaysCL > bottleneckCL) { bottleneckCL = todaysCL; bottleneckSubject = task.subject; }
            }
        });

        return {
            taskSpread, strictCL: projectedCL, simCL: projectedCL,
            pendingDriftTasks: drifts,
            missionsReq, missionsDone,
            totalActive, totalDebt,
            bottleneckSubject, bottleneckCL,
            chartDatasets,
            _debtTasks: debtTasks,
            _sprintTasks: sprintTasks,
            _marathonTasks: marathonTasks,
            _taskSpread: taskSpread
        };
    }
};
