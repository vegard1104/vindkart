// =====================================================================
// CONFIG
// =====================================================================
const DEFAULT_LAT = 61.03219;
const DEFAULT_LNG = 7.30878;
const FORECAST_DAYS = 7;
const GRID_SIZE = 6;

// =====================================================================
// STATE
// =====================================================================
let appMode = 'weather'; // 'weather' | 'tour'
let dates = [];
let selectedDate = '';
let currentHour = 12;
let particleCount = 500;
let animationEnabled = true;
let animFrameId = null;
let isLoadingGrid = false;
let fetchDebounceTimer = null;
let activeTab = 'wind';

// Weather grid data
let weatherGrid = {};
let gridBounds = null;
let gridLats = [];
let gridLngs = [];

// Marker system
let weatherMarkers = [];

// Tour mode state
let tourDrawing = true;
let tourWaypoints = [];
let tourPolyline = null;
let tourElevations = [];
let tourMarkers = [];

// NVE layers
let steepnessLayer = null;
let steepnessVisible = false;
let avalancheLayer = null;
let avalancheVisible = false;

// =====================================================================
// MAP
// =====================================================================
const map = L.map('map', { zoomControl: true }).setView([DEFAULT_LAT, DEFAULT_LNG], 10);
L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', {
    attribution: '&copy; <a href="https://kartverket.no">Kartverket</a> | V&aelig;r: Open-Meteo | NVE/Varsom',
    maxZoom: 18
}).addTo(map);

// GPS Geolocation — replaces the red center dot
let gpsMarker = null;
let gpsAccuracyCircle = null;
let gpsHeading = null;
let gpsWatchId = null;

function initGeolocation() {
    if (!navigator.geolocation) {
        console.warn('Geolocation not supported');
        // Fallback: place a static marker at default pos
        addFallbackMarker();
        return;
    }
    gpsWatchId = navigator.geolocation.watchPosition(
        function(pos) {
            const lat = pos.coords.latitude, lng = pos.coords.longitude;
            const accuracy = pos.coords.accuracy;
            gpsHeading = pos.coords.heading; // may be null

            if (!gpsMarker) {
                // Create GPS arrow marker
                const arrowHtml = '<div style="position:relative;">' +
                    '<div class="gps-pulse"></div>' +
                    '<div class="gps-arrow" id="gpsArrow">' +
                    '<div style="width:22px;height:22px;display:flex;align-items:center;justify-content:center;">' +
                    '<svg width="22" height="22" viewBox="0 0 24 24" fill="#4285f4" stroke="#fff" stroke-width="1.5">' +
                    '<path d="M12 2 L4 20 L12 15 L20 20 Z"/></svg></div></div></div>';
                gpsMarker = L.marker([lat, lng], {
                    icon: L.divIcon({
                        className: '',
                        html: arrowHtml,
                        iconSize: [22, 22], iconAnchor: [11, 11]
                    }),
                    zIndexOffset: 1000
                }).addTo(map).bindPopup('<b>Din posisjon</b><br>' + lat.toFixed(5) + '\u00b0N, ' + lng.toFixed(5) + '\u00b0E');

                gpsAccuracyCircle = L.circle([lat, lng], {
                    radius: accuracy, color: '#4285f4', fillColor: '#4285f4',
                    fillOpacity: 0.08, weight: 1, opacity: 0.3
                }).addTo(map);

                // Only fly to GPS position on first fix
                map.setView([lat, lng], map.getZoom());
            } else {
                gpsMarker.setLatLng([lat, lng]);
                gpsMarker.setPopupContent('<b>Din posisjon</b><br>' + lat.toFixed(5) + '\u00b0N, ' + lng.toFixed(5) + '\u00b0E<br><span style="font-size:10px;color:#888;">N\u00f8yaktighet: \u00b1' + Math.round(accuracy) + ' m</span>');
                gpsAccuracyCircle.setLatLng([lat, lng]);
                gpsAccuracyCircle.setRadius(accuracy);
            }

            // Rotate arrow based on heading
            if (gpsHeading !== null && gpsHeading !== undefined && !isNaN(gpsHeading)) {
                const arrowEl = document.getElementById('gpsArrow');
                if (arrowEl) arrowEl.style.transform = 'rotate(' + gpsHeading + 'deg)';
            }
        },
        function(err) {
            console.warn('Geolocation error:', err.message);
            addFallbackMarker();
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
}

function addFallbackMarker() {
    if (!gpsMarker) {
        gpsMarker = L.circleMarker([DEFAULT_LAT, DEFAULT_LNG], {
            radius: 7, color: '#4285f4', fillColor: '#4285f4', fillOpacity: 0.9, weight: 2
        }).addTo(map).bindPopup('<b>Standardposisjon</b><br>61\u00b001\'55.9"N 7\u00b018\'31.6"E<br><span style="font-size:10px;color:#888;">GPS ikke tilgjengelig</span>');
    }
}

// Kartverket Friluftsruter WMS layer
let friluftsruterLayer = null;
let friluftsruterVisible = false;

// =====================================================================
// CANVASES
// =====================================================================
const windCanvas = document.getElementById('windCanvas');
const windCtx = windCanvas.getContext('2d');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');
let particles = [];

function resizeCanvases() {
    windCanvas.width = window.innerWidth;
    windCanvas.height = window.innerHeight;
    overlayCanvas.width = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// =====================================================================
// GRID INTERPOLATION (all weather params)
// =====================================================================
function getDataAtLatLng(lat, lng, date, hour) {
    const grid = weatherGrid[date];
    if (!grid || !grid[hour]) return null;
    const data = grid[hour];
    const latStep = gridLats.length > 1 ? gridLats[1] - gridLats[0] : 1;
    const lngStep = gridLngs.length > 1 ? gridLngs[1] - gridLngs[0] : 1;
    const fi = (lat - gridLats[0]) / latStep;
    const fj = (lng - gridLngs[0]) / lngStep;
    const i0 = Math.max(0, Math.min(gridLats.length - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(gridLngs.length - 2, Math.floor(fj)));
    const i1 = i0 + 1, j1 = j0 + 1;
    const ti = Math.max(0, Math.min(1, fi - i0));
    const tj = Math.max(0, Math.min(1, fj - j0));

    function bilerp(arr) {
        return arr[i0][j0]*(1-ti)*(1-tj) + arr[i0][j1]*(1-ti)*tj + arr[i1][j0]*ti*(1-tj) + arr[i1][j1]*ti*tj;
    }
    // Wind direction vector interpolation
    const toRad = d => d * Math.PI / 180;
    const d00=data.dirs[i0][j0], d01=data.dirs[i0][j1], d10=data.dirs[i1][j0], d11=data.dirs[i1][j1];
    const ix = Math.sin(toRad(d00))*(1-ti)*(1-tj)+Math.sin(toRad(d01))*(1-ti)*tj+Math.sin(toRad(d10))*ti*(1-tj)+Math.sin(toRad(d11))*ti*tj;
    const iy = Math.cos(toRad(d00))*(1-ti)*(1-tj)+Math.cos(toRad(d01))*(1-ti)*tj+Math.cos(toRad(d10))*ti*(1-tj)+Math.cos(toRad(d11))*ti*tj;
    let dir = Math.atan2(ix, iy) * 180 / Math.PI;
    if (dir < 0) dir += 360;
    const ni = ti < 0.5 ? i0 : i1, nj = tj < 0.5 ? j0 : j1;

    return {
        dir, speed: bilerp(data.speeds), gust: bilerp(data.gusts),
        temp: bilerp(data.temps), feelslike: bilerp(data.feelslike),
        precip: bilerp(data.precip), precipProb: bilerp(data.precipProb),
        snowfall: bilerp(data.snowfall), weatherCode: data.weatherCode[ni][nj],
        humidity: bilerp(data.humidity), cloudCover: bilerp(data.cloudCover),
        visibility: bilerp(data.visibility), dewpoint: bilerp(data.dewpoint),
        pressure: bilerp(data.pressure), uvIndex: bilerp(data.uvIndex),
        snowDepth: bilerp(data.snowDepth)
    };
}

function screenToLatLng(x, y) {
    const p = map.containerPointToLatLng([x, y]);
    return { lat: p.lat, lng: p.lng };
}

// =====================================================================
// WMO WEATHER CODE HELPERS
// =====================================================================
function wmoToEmoji(c) {
    if (c===0) return '\u2600\uFE0F';
    if (c<=3) return '\u26C5';
    if (c===45||c===48) return '\uD83C\uDF2B\uFE0F';
    if (c>=51&&c<=55) return '\uD83C\uDF26\uFE0F';
    if (c>=56&&c<=57) return '\u2744\uFE0F';
    if (c>=61&&c<=65) return '\uD83C\uDF27\uFE0F';
    if (c>=66&&c<=67) return '\u2744\uFE0F';
    if (c>=71&&c<=77) return '\uD83C\uDF28\uFE0F';
    if (c>=80&&c<=82) return '\uD83C\uDF26\uFE0F';
    if (c>=85&&c<=86) return '\uD83C\uDF28\uFE0F';
    if (c===95) return '\u26C8\uFE0F';
    if (c>=96) return '\u26C8\uFE0F';
    return '\u2601\uFE0F';
}
function wmoToDesc(c) {
    if (c===0) return 'Klar himmel'; if (c===1) return 'Stort sett klart'; if (c===2) return 'Delvis skyet'; if (c===3) return 'Overskyet';
    if (c===45) return 'T\u00e5ke'; if (c===48) return 'Rimfrost-t\u00e5ke';
    if (c>=51&&c<=53) return 'Yr'; if (c>=54&&c<=55) return 'Kraftig yr';
    if (c>=56&&c<=57) return 'Underkj\u00f8lt yr';
    if (c===61) return 'Lett regn'; if (c===63) return 'Moderat regn'; if (c===65) return 'Kraftig regn';
    if (c>=66&&c<=67) return 'Underkj\u00f8lt regn';
    if (c===71) return 'Lett sn\u00f8fall'; if (c===73) return 'Moderat sn\u00f8fall'; if (c===75) return 'Kraftig sn\u00f8fall'; if (c===77) return 'Sn\u00f8korn';
    if (c>=80&&c<=82) return 'Regnbyger'; if (c>=85&&c<=86) return 'Sn\u00f8byger';
    if (c===95) return 'Tordenver'; if (c>=96) return 'Tordenver med hagl';
    return 'Ukjent';
}

// =====================================================================
// COLOR HELPERS
// =====================================================================
function speedColor(s) { if(s<2) return 'rgb(74,158,190)'; if(s<5) return 'rgb(100,200,220)'; if(s<8) return 'rgb(46,204,113)'; if(s<11) return 'rgb(241,196,15)'; if(s<14) return 'rgb(230,126,34)'; if(s<18) return 'rgb(231,76,60)'; return 'rgb(142,68,173)'; }
function windColorHex(s) { if(s<5) return '#4a9ebe'; if(s<8) return '#2ecc71'; if(s<14) return '#f1c40f'; if(s<20) return '#e74c3c'; return '#8e44ad'; }
function tempColor(t) { if(t<-10) return 'rgb(59,72,217)'; if(t<-5) return 'rgb(70,120,200)'; if(t<0) return 'rgb(74,158,190)'; if(t<5) return 'rgb(60,180,170)'; if(t<10) return 'rgb(46,204,113)'; if(t<15) return 'rgb(180,210,50)'; if(t<20) return 'rgb(241,196,15)'; if(t<25) return 'rgb(230,126,34)'; if(t<30) return 'rgb(231,76,60)'; return 'rgb(180,40,40)'; }
function precipColor(mm) { if(mm<0.1) return 'rgba(44,62,80,0.3)'; if(mm<1) return 'rgba(52,152,219,0.7)'; if(mm<5) return 'rgba(41,128,185,0.85)'; return 'rgba(142,68,173,0.95)'; }
function weatherCodeColor(c) { if(c===0) return 'rgba(243,156,18,0.8)'; if(c<=3) return 'rgba(149,165,166,0.7)'; if(c===45||c===48) return 'rgba(189,195,199,0.6)'; if(c>=51&&c<=67) return 'rgba(52,152,219,0.8)'; if(c>=71&&c<=77) return 'rgba(236,240,241,0.8)'; if(c>=80&&c<=86) return 'rgba(52,152,219,0.8)'; if(c>=95) return 'rgba(155,89,182,0.9)'; return 'rgba(149,165,166,0.5)'; }

// =====================================================================
// PARTICLE SYSTEM
// =====================================================================

class WindParticle {
    constructor() { this.history = []; this.speed = 0; this.reset(true); }
    reset(randomAge) {
        this.x = Math.random() * windCanvas.width;
        this.y = Math.random() * windCanvas.height;
        this.maxAge = 60 + Math.random() * 80;
        this.age = randomAge ? Math.random() * this.maxAge * 0.5 : 0;
        this.history = [];
        this.speed = 0;
    }
    update() {
        if (this.age >= this.maxAge) { this.reset(); return; }
        this.age++;
        try {
            const pos = screenToLatLng(this.x, this.y);
            const d = getDataAtLatLng(pos.lat, pos.lng, selectedDate, currentHour);
            if (!d) return;
            this.speed = d.speed;
            const toRad = (d.dir + 180) % 360 * Math.PI / 180;
            const sf = Math.max(0.5, d.speed * 0.35);
            this.history.push({ x: this.x, y: this.y });
            if (this.history.length > 14) this.history.shift();
            this.x += Math.sin(toRad) * sf + (Math.random() - 0.5) * 0.8;
            this.y += -Math.cos(toRad) * sf + (Math.random() - 0.5) * 0.8;
            if (this.x < -10 || this.x > windCanvas.width + 10 || this.y < -10 || this.y > windCanvas.height + 10) this.reset();
        } catch(e) { /* skip frame on error */ }
    }
    draw(ctx) {
        if (this.history.length < 2) return;
        const lr = 1 - this.age / this.maxAge;
        const baseAlpha = Math.min(1, lr * 1.2);
        const c = speedColor(this.speed);
        // Draw trail
        for (let i = 1; i < this.history.length; i++) {
            const a = baseAlpha * (i / this.history.length) * 0.6;
            ctx.beginPath();
            ctx.moveTo(this.history[i-1].x, this.history[i-1].y);
            ctx.lineTo(this.history[i].x, this.history[i].y);
            ctx.strokeStyle = c.replace('rgb', 'rgba').replace(')', ',' + a.toFixed(2) + ')');
            ctx.lineWidth = 1.2 + this.speed * 0.08;
            ctx.lineCap = 'round';
            ctx.stroke();
        }
        // Draw line to current pos
        const lastH = this.history[this.history.length - 1];
        ctx.beginPath();
        ctx.moveTo(lastH.x, lastH.y);
        ctx.lineTo(this.x, this.y);
        ctx.strokeStyle = c.replace('rgb', 'rgba').replace(')', ',' + (baseAlpha * 0.6).toFixed(2) + ')');
        ctx.lineWidth = 1.2 + this.speed * 0.08;
        ctx.lineCap = 'round';
        ctx.stroke();
        // Head dot
        ctx.beginPath();
        ctx.arc(this.x, this.y, 1.5 + this.speed * 0.08, 0, Math.PI * 2);
        ctx.fillStyle = c.replace('rgb', 'rgba').replace(')', ',' + Math.min(1, baseAlpha * 1.1).toFixed(2) + ')');
        ctx.fill();
    }
}

function initParticles() { particles = []; for (let i = 0; i < particleCount; i++) particles.push(new WindParticle()); }

// =====================================================================
// OVERLAY RENDERING (temp/precip/weather)
// =====================================================================
function drawOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (appMode !== 'weather' || activeTab === 'wind') return;
    if (!weatherGrid[selectedDate] || !weatherGrid[selectedDate][currentHour]) return;
    const gs = 4, px = overlayCanvas.width*0.08, py = overlayCanvas.height*0.08;
    const sx = (overlayCanvas.width-2*px)/(gs-1), sy = (overlayCanvas.height-2*py)/(gs-1);
    for (let gy=0; gy<gs; gy++) for (let gx=0; gx<gs; gx++) {
        const x=px+gx*sx, y=py+gy*sy;
        const pos = screenToLatLng(x, y);
        const d = getDataAtLatLng(pos.lat, pos.lng, selectedDate, currentHour);
        if (!d) continue;
        if (activeTab==='temp') drawTempPoint(overlayCtx,x,y,d.temp);
        else if (activeTab==='precip') drawPrecipPoint(overlayCtx,x,y,d.precip,d.snowfall);
        else if (activeTab==='weather') drawWeatherPoint(overlayCtx,x,y,d.weatherCode);
    }
}

function drawTempPoint(ctx,x,y,temp) {
    const c=tempColor(temp);
    const g=ctx.createRadialGradient(x,y,0,x,y,32); g.addColorStop(0,c.replace('rgb','rgba').replace(')',',.35)')); g.addColorStop(1,c.replace('rgb','rgba').replace(')',',.0)'));
    ctx.beginPath(); ctx.arc(x,y,32,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,14,0,Math.PI*2); ctx.fillStyle=c.replace('rgb','rgba').replace(')',',.85)'); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.font='bold 11px -apple-system,sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(Math.round(temp)+'\u00b0',x,y);
}
function drawPrecipPoint(ctx,x,y,precip,snow) {
    const c=precipColor(precip), isSnow=snow>0.1, r=Math.min(26,8+precip*3);
    const g=ctx.createRadialGradient(x,y,0,x,y,r+16); g.addColorStop(0,c); g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(x,y,r+16,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle=c; ctx.fill();
    ctx.strokeStyle=isSnow?'rgba(255,255,255,.5)':'rgba(100,180,255,.3)'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.font='bold 10px -apple-system,sans-serif'; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    if(precip<0.1) ctx.fillText('-',x,y);
    else { ctx.fillText(precip.toFixed(1),x,y-4); ctx.font='8px sans-serif'; ctx.fillStyle='rgba(255,255,255,.7)'; ctx.fillText(isSnow?'mm sn\u00f8':'mm',x,y+7); }
}
function drawWeatherPoint(ctx,x,y,code) {
    const c=weatherCodeColor(code);
    const g=ctx.createRadialGradient(x,y,0,x,y,30); g.addColorStop(0,c); g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(x,y,30,0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
    ctx.font='24px serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(wmoToEmoji(code),x,y);
}

// =====================================================================
// ANIMATION LOOP
// =====================================================================
function animate() {
    try {
        if (appMode !== 'weather' || activeTab !== 'wind' || !animationEnabled) {
            windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
            if (appMode === 'weather' && activeTab === 'wind' && !animationEnabled) return;
            if (appMode !== 'weather' || activeTab !== 'wind') { animFrameId = requestAnimationFrame(animate); return; }
            return;
        }
        if (!weatherGrid[selectedDate] || !weatherGrid[selectedDate][currentHour]) {
            animFrameId = requestAnimationFrame(animate);
            return;
        }
        windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
        while (particles.length < particleCount) particles.push(new WindParticle());
        while (particles.length > particleCount) particles.pop();
        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
            particles[i].draw(windCtx);
        }
    } catch(e) {
        console.error('Wind animation error:', e);
    }
    animFrameId = requestAnimationFrame(animate);
}

// =====================================================================
// API FETCH
// =====================================================================
function getMapGridBounds() {
    const b=map.getBounds(), pad=0.15;
    const latR=b.getNorth()-b.getSouth(), lngR=b.getEast()-b.getWest();
    return { south:b.getSouth()-latR*pad, north:b.getNorth()+latR*pad, west:b.getWest()-lngR*pad, east:b.getEast()+lngR*pad };
}

async function fetchWeatherGrid() {
    if (isLoadingGrid) return;
    isLoadingGrid = true;
    const statusEl = document.getElementById('gridStatus');
    statusEl.textContent = 'Henter v\u00e6rrutenett...'; statusEl.classList.add('loading');

    const b = getMapGridBounds(); gridBounds = b;
    const lats=[], lngs=[];
    for (let i=0;i<GRID_SIZE;i++) { lats.push(b.south+(b.north-b.south)*i/(GRID_SIZE-1)); lngs.push(b.west+(b.east-b.west)*i/(GRID_SIZE-1)); }
    gridLats=lats; gridLngs=lngs;

    const flatLats=[], flatLngs=[];
    for (let i=0;i<GRID_SIZE;i++) for (let j=0;j<GRID_SIZE;j++) { flatLats.push(lats[i].toFixed(4)); flatLngs.push(lngs[j].toFixed(4)); }

    const url = 'https://api.open-meteo.com/v1/forecast?' +
        'latitude=' + flatLats.join(',') + '&longitude=' + flatLngs.join(',') +
        '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,weather_code,relative_humidity_2m,cloud_cover,visibility,dew_point_2m,surface_pressure,uv_index,snow_depth' +
        '&forecast_days=' + FORECAST_DAYS + '&timezone=Europe%2FOslo&wind_speed_unit=ms';

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const results = Array.isArray(json) ? json : [json];
        const newGrid = {};
        const times = results[0].hourly.time;
        const newDates = [];
        for (let t=0; t<times.length; t++) { const dt=times[t].substring(0,10); if(!newDates.includes(dt)) newDates.push(dt); }

        for (const dt of newDates) { newGrid[dt]={}; for (let h=0;h<24;h++) {
            newGrid[dt][h] = {
                dirs: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                speeds: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                gusts: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                temps: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                feelslike: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                precip: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                precipProb: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                snowfall: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                weatherCode: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                humidity: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                cloudCover: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                visibility: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                dewpoint: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                pressure: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                uvIndex: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0)),
                snowDepth: Array.from({length:GRID_SIZE},()=>new Array(GRID_SIZE).fill(0))
            };
        }}

        for (let idx=0; idx<results.length; idx++) {
            const i=Math.floor(idx/GRID_SIZE), j=idx%GRID_SIZE, h=results[idx].hourly;
            for (let t=0;t<h.time.length;t++) {
                const dt=h.time[t].substring(0,10), hour=parseInt(h.time[t].substring(11,13));
                if (newGrid[dt]&&newGrid[dt][hour]) {
                    const c=newGrid[dt][hour];
                    c.dirs[i][j]=h.wind_direction_10m[t]||0; c.speeds[i][j]=h.wind_speed_10m[t]||0; c.gusts[i][j]=h.wind_gusts_10m[t]||0;
                    c.temps[i][j]=h.temperature_2m[t]!==undefined?h.temperature_2m[t]:0;
                    c.feelslike[i][j]=h.apparent_temperature[t]!==undefined?h.apparent_temperature[t]:0;
                    c.precip[i][j]=h.precipitation[t]||0; c.precipProb[i][j]=h.precipitation_probability[t]||0;
                    c.snowfall[i][j]=h.snowfall[t]||0; c.weatherCode[i][j]=h.weather_code[t]||0;
                    c.humidity[i][j]=h.relative_humidity_2m[t]||0; c.cloudCover[i][j]=h.cloud_cover[t]||0;
                    c.visibility[i][j]=h.visibility[t]||0; c.dewpoint[i][j]=h.dew_point_2m[t]||0;
                    c.pressure[i][j]=h.surface_pressure[t]||0; c.uvIndex[i][j]=h.uv_index[t]||0;
                    c.snowDepth[i][j]=h.snow_depth[t]||0;
                }
            }
        }
        weatherGrid = newGrid;
        if (dates.length===0) { dates=newDates.sort(); selectedDate=dates.length>1?dates[1]:dates[0]; buildDateButtons(); }
        updateDisplay(); drawOverlay();
        statusEl.textContent = 'V\u00e6rrutenett: ' + (GRID_SIZE*GRID_SIZE) + ' punkter'; statusEl.classList.remove('loading');
    } catch (e) { statusEl.textContent = 'Feil: ' + e.message; statusEl.classList.remove('loading'); }
    isLoadingGrid = false;
}

// =====================================================================
// MARKER SYSTEM — click to get detailed weather
// =====================================================================
function createWeatherMarkerPopup(lat, lng, data, markerId) {
    return '<div class="marker-popup">' +
        '<h3>' + lat.toFixed(4) + '\u00b0N, ' + lng.toFixed(4) + '\u00b0E</h3>' +
        '<div class="mp-section">Vind</div>' +
        '<div class="mp-row"><span class="mp-label">Retning</span><span class="mp-val">' + Math.round(data.dir) + '\u00b0 (' + directionName(data.dir) + ')</span></div>' +
        '<div class="mp-row"><span class="mp-label">Hastighet</span><span class="mp-val">' + data.speed.toFixed(1) + ' m/s</span></div>' +
        '<div class="mp-row"><span class="mp-label">Kast</span><span class="mp-val">' + data.gust.toFixed(1) + ' m/s</span></div>' +
        '<div class="mp-section">Temperatur</div>' +
        '<div class="mp-row"><span class="mp-label">Temperatur</span><span class="mp-val">' + data.temp.toFixed(1) + '\u00b0C</span></div>' +
        '<div class="mp-row"><span class="mp-label">F\u00f8les som</span><span class="mp-val">' + data.feelslike.toFixed(1) + '\u00b0C</span></div>' +
        '<div class="mp-row"><span class="mp-label">Duggpunkt</span><span class="mp-val">' + data.dewpoint.toFixed(1) + '\u00b0C</span></div>' +
        '<div class="mp-section">Fuktighet & sky</div>' +
        '<div class="mp-row"><span class="mp-label">Luftfuktighet</span><span class="mp-val">' + Math.round(data.humidity) + '%</span></div>' +
        '<div class="mp-row"><span class="mp-label">Skydekke</span><span class="mp-val">' + Math.round(data.cloudCover) + '%</span></div>' +
        '<div class="mp-row"><span class="mp-label">Sikt</span><span class="mp-val">' + (data.visibility/1000).toFixed(1) + ' km</span></div>' +
        '<div class="mp-section">Nedb\u00f8r & sn\u00f8</div>' +
        '<div class="mp-row"><span class="mp-label">Nedb\u00f8r</span><span class="mp-val">' + data.precip.toFixed(1) + ' mm</span></div>' +
        '<div class="mp-row"><span class="mp-label">Sannsynlighet</span><span class="mp-val">' + Math.round(data.precipProb) + '%</span></div>' +
        '<div class="mp-row"><span class="mp-label">Sn\u00f8fall</span><span class="mp-val">' + data.snowfall.toFixed(1) + ' cm</span></div>' +
        '<div class="mp-row"><span class="mp-label">Sn\u00f8dybde</span><span class="mp-val">' + data.snowDepth.toFixed(2) + ' m</span></div>' +
        '<div class="mp-section">Annet</div>' +
        '<div class="mp-row"><span class="mp-label">Lufttrykk</span><span class="mp-val">' + Math.round(data.pressure) + ' hPa</span></div>' +
        '<div class="mp-row"><span class="mp-label">UV-indeks</span><span class="mp-val">' + data.uvIndex.toFixed(1) + '</span></div>' +
        '<div class="mp-row"><span class="mp-label">V\u00e6r</span><span class="mp-val">' + wmoToEmoji(data.weatherCode) + ' ' + wmoToDesc(data.weatherCode) + '</span></div>' +
        '<button class="mp-remove" onclick="removeWeatherMarker(' + markerId + ')">Fjern mark\u00f8r</button>' +
        '</div>';
}

function removeWeatherMarker(id) {
    const idx = weatherMarkers.findIndex(m => m.id === id);
    if (idx >= 0) { map.removeLayer(weatherMarkers[idx].marker); weatherMarkers.splice(idx, 1); }
}

let markerIdCounter = 0;

// =====================================================================
// TOUR MODE — Route drawing
// =====================================================================
function haversine(lat1, lng1, lat2, lng2) {
    const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getTotalDistance() {
    let d=0;
    for (let i=1; i<tourWaypoints.length; i++)
        d += haversine(tourWaypoints[i-1].lat, tourWaypoints[i-1].lng, tourWaypoints[i].lat, tourWaypoints[i].lng);
    return d;
}

async function fetchElevations() {
    if (tourWaypoints.length === 0) { tourElevations=[]; return; }
    // Use Open-Meteo elevation API
    const lats = tourWaypoints.map(w => w.lat.toFixed(4)).join(',');
    const lngs = tourWaypoints.map(w => w.lng.toFixed(4)).join(',');
    try {
        const res = await fetch('https://api.open-meteo.com/v1/elevation?latitude=' + lats + '&longitude=' + lngs);
        const json = await res.json();
        tourElevations = json.elevation || [];
    } catch(e) { console.warn('Elevation fetch failed:', e); }
}

function updateTourStats() {
    const dist = getTotalDistance();
    document.getElementById('tourDist').textContent = dist < 1 ? (dist*1000).toFixed(0) + ' m' : dist.toFixed(2) + ' km';
    document.getElementById('tourPoints').textContent = tourWaypoints.length;

    if (tourElevations.length >= 2) {
        const min = Math.min(...tourElevations), max = Math.max(...tourElevations);
        document.getElementById('tourElev').textContent = Math.round(min) + ' / ' + Math.round(max) + ' moh';
        let asc=0, desc=0;
        for (let i=1; i<tourElevations.length; i++) {
            const diff = tourElevations[i]-tourElevations[i-1];
            if (diff>0) asc+=diff; else desc+=Math.abs(diff);
        }
        document.getElementById('tourAscent').textContent = Math.round(asc) + ' m';
        document.getElementById('tourDescent').textContent = Math.round(desc) + ' m';
    } else {
        document.getElementById('tourElev').textContent = '\u2014';
        document.getElementById('tourAscent').textContent = '\u2014';
        document.getElementById('tourDescent').textContent = '\u2014';
    }
    drawElevationProfile();
}

function drawElevationProfile() {
    const canvas = document.getElementById('elevationProfile');
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2,2);
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    ctx.clearRect(0,0,w,h);

    if (tourElevations.length < 2) {
        ctx.fillStyle='#444'; ctx.font='11px sans-serif'; ctx.textAlign='center';
        ctx.fillText('H\u00f8ydeprofil vises n\u00e5r ruten har 2+ punkter', w/2, h/2);
        return;
    }

    const min = Math.min(...tourElevations)-20, max = Math.max(...tourElevations)+20;
    const range = max-min || 1;
    const pad = { top:10, bot:20, left:35, right:10 };
    const pw = w-pad.left-pad.right, ph = h-pad.top-pad.bot;

    // Cumulative distances
    const dists = [0];
    for (let i=1; i<tourWaypoints.length; i++) dists.push(dists[i-1]+haversine(tourWaypoints[i-1].lat,tourWaypoints[i-1].lng,tourWaypoints[i].lat,tourWaypoints[i].lng));
    const totalDist = dists[dists.length-1] || 1;

    // Fill gradient
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top+ph);
    for (let i=0; i<tourElevations.length; i++) {
        const x = pad.left + (dists[i]/totalDist)*pw;
        const y = pad.top + ph - ((tourElevations[i]-min)/range)*ph;
        if (i===0) ctx.lineTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.lineTo(pad.left+pw, pad.top+ph);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0,pad.top,0,pad.top+ph);
    grad.addColorStop(0,'rgba(126,200,227,0.3)'); grad.addColorStop(1,'rgba(126,200,227,0.02)');
    ctx.fillStyle = grad; ctx.fill();

    // Line
    ctx.beginPath();
    for (let i=0; i<tourElevations.length; i++) {
        const x = pad.left + (dists[i]/totalDist)*pw;
        const y = pad.top + ph - ((tourElevations[i]-min)/range)*ph;
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.strokeStyle='#7ec8e3'; ctx.lineWidth=1.5; ctx.stroke();

    // Points
    for (let i=0; i<tourElevations.length; i++) {
        const x = pad.left + (dists[i]/totalDist)*pw;
        const y = pad.top + ph - ((tourElevations[i]-min)/range)*ph;
        ctx.beginPath(); ctx.arc(x,y,2.5,0,Math.PI*2); ctx.fillStyle='#7ec8e3'; ctx.fill();
    }

    // Y axis labels
    ctx.fillStyle='#555'; ctx.font='9px sans-serif'; ctx.textAlign='right';
    ctx.fillText(Math.round(max)+' m', pad.left-4, pad.top+8);
    ctx.fillText(Math.round(min)+' m', pad.left-4, pad.top+ph);

    // X axis
    ctx.textAlign='center';
    ctx.fillText('0', pad.left, pad.top+ph+12);
    ctx.fillText(totalDist.toFixed(1)+' km', pad.left+pw, pad.top+ph+12);
}

function updateTourPolyline() {
    const latlngs = tourWaypoints.map(w => [w.lat, w.lng]);
    if (tourPolyline) map.removeLayer(tourPolyline);
    if (latlngs.length >= 2) {
        tourPolyline = L.polyline(latlngs, { color:'#7ec8e3', weight:3, opacity:0.8 }).addTo(map);
    }
}

function addTourWaypoint(lat, lng) {
    tourWaypoints.push({ lat, lng });
    const marker = L.circleMarker([lat, lng], {
        radius: 6, color: '#7ec8e3', fillColor: '#7ec8e3', fillOpacity: 0.9, weight: 2
    }).addTo(map);
    const idx = tourWaypoints.length;
    marker.bindTooltip('Punkt ' + idx, { direction:'top', offset:[0,-8] });
    tourMarkers.push(marker);
    updateTourPolyline();
    fetchElevations().then(() => updateTourStats());
}

function undoTourPoint() {
    if (tourWaypoints.length === 0) return;
    tourWaypoints.pop();
    const m = tourMarkers.pop();
    if (m) map.removeLayer(m);
    tourElevations = tourElevations.slice(0, tourWaypoints.length);
    updateTourPolyline();
    updateTourStats();
}

function clearTourRoute() {
    tourWaypoints = []; tourElevations = [];
    tourMarkers.forEach(m => map.removeLayer(m)); tourMarkers = [];
    if (tourPolyline) { map.removeLayer(tourPolyline); tourPolyline = null; }
    updateTourStats();
}

// =====================================================================
// NVE LAYERS
// =====================================================================
function toggleSteepnessLayer() {
    steepnessVisible = !steepnessVisible;
    document.getElementById('toggleSteepness').classList.toggle('on', steepnessVisible);
    document.getElementById('legend-steepness').style.display = steepnessVisible ? '' : 'none';

    if (steepnessVisible && !steepnessLayer) {
        steepnessLayer = L.tileLayer('https://gis3.nve.no/arcgis/rest/services/wmts/Bratthet_med_utlop_2024/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Bratthet: NVE', maxZoom: 18, opacity: 0.6, zIndex: 400
        }).addTo(map);
    } else if (steepnessVisible && steepnessLayer) {
        steepnessLayer.addTo(map);
    } else if (!steepnessVisible && steepnessLayer) {
        map.removeLayer(steepnessLayer);
    }
}

function toggleAvalancheLayer() {
    avalancheVisible = !avalancheVisible;
    document.getElementById('toggleAvalanche').classList.toggle('on', avalancheVisible);
    document.getElementById('avalancheInfo').style.display = avalancheVisible ? '' : 'none';

    if (avalancheVisible && !avalancheLayer) {
        avalancheLayer = L.tileLayer('https://gis3.nve.no/arcgis/rest/services/wmts/KastsijkkelSn662024/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Sn\u00f8skred: NVE', maxZoom: 18, opacity: 0.5, zIndex: 399
        }).addTo(map);
        fetchAvalancheWarning();
    } else if (avalancheVisible && avalancheLayer) {
        avalancheLayer.addTo(map);
        fetchAvalancheWarning();
    } else if (!avalancheVisible && avalancheLayer) {
        map.removeLayer(avalancheLayer);
    }
}

async function fetchAvalancheWarning() {
    const today = new Date().toISOString().substring(0,10);
    // Region 3027 = Indre Fjordane (covers Sogn area). Try fetching from NVE API.
    try {
        const url = 'https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/AvalancheWarningByRegion/Simple/3027/1/' + today + '/' + today;
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json && json.length > 0) {
            const w = json[0];
            const dl = w.DangerLevel || w.dangerLevel || 0;
            const rn = w.RegionName || w.regionName || 'Indre Fjordane';
            const dangerNames = ['Ukjent','1 - Liten','2 - Moderat','3 - Betydelig','4 - Stor','5 - Meget stor'];
            document.getElementById('avDanger').textContent = dangerNames[dl] || ('Faregrad ' + dl);
            document.getElementById('avRegion').textContent = rn;
            document.getElementById('avDate').textContent = today;
            document.getElementById('avLevel').textContent = dangerNames[dl] || '';

            const box = document.getElementById('avBox');
            box.className = 'avalanche-box av-danger-' + Math.max(1, Math.min(5, dl));
        }
    } catch(e) {
        document.getElementById('avDanger').textContent = 'Kunne ikke hente';
        document.getElementById('avRegion').textContent = 'Sjekk varsom.no';
        document.getElementById('avDate').textContent = today;
        document.getElementById('avLevel').textContent = 'Se varsom.no for detaljer';
    }
}

// =====================================================================
// MAP EVENTS
// =====================================================================
map.on('movestart zoomstart', () => {
    windCtx.clearRect(0,0,windCanvas.width,windCanvas.height);
    overlayCtx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
    particles.forEach(p => p.history = []);
});

map.on('moveend zoomend', () => {
    clearTimeout(fetchDebounceTimer);
    fetchDebounceTimer = setTimeout(() => { fetchWeatherGrid(); updateLocationSubtitle(); }, 600);
});

map.on('click', function(e) {
    if (appMode === 'weather') {
        // Place weather marker
        const data = getDataAtLatLng(e.latlng.lat, e.latlng.lng, selectedDate, currentHour);
        if (!data) return;
        const id = ++markerIdCounter;
        const marker = L.marker(e.latlng, { icon: L.divIcon({
            className: '', html: '<div style="width:14px;height:14px;background:#7ec8e3;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>', iconSize:[14,14], iconAnchor:[7,7]
        })}).addTo(map);
        marker.bindPopup(createWeatherMarkerPopup(e.latlng.lat, e.latlng.lng, data, id), { maxWidth: 280 }).openPopup();
        weatherMarkers.push({ id, marker });
    } else if (appMode === 'tour' && tourDrawing && activeTourTab === 'planlegg') {
        addTourWaypoint(e.latlng.lat, e.latlng.lng);
    }
});

function updateLocationSubtitle() {
    const c = map.getCenter();
    document.getElementById('locationSubtitle').textContent = c.lat.toFixed(3)+'\u00b0N, '+c.lng.toFixed(3)+'\u00b0E';
}

// =====================================================================
// INITIAL LOAD
// =====================================================================
async function loadData() {
    const loading=document.getElementById('loading'), spinner=document.getElementById('spinner');
    const errorText=document.getElementById('errorText'), retryBtn=document.getElementById('retryBtn'), loadingText=document.getElementById('loadingText');
    loading.style.display='flex'; spinner.style.display='block'; errorText.style.display='none'; retryBtn.style.display='none';
    loadingText.textContent='Henter v\u00e6rdata (' + (GRID_SIZE*GRID_SIZE) + ' punkter)...';
    try {
        await fetchWeatherGrid();
        loading.style.display='none'; updateLocationSubtitle(); updateDisplay(); drawOverlay(); initParticles(); animate(); autoCollapseOnMobile();
        initGeolocation();
    } catch(e) {
        spinner.style.display='none'; loadingText.textContent='Kunne ikke hente v\u00e6rdata';
        errorText.style.display='block'; errorText.textContent=e.message; retryBtn.style.display='inline-block';
    }
}

// =====================================================================
// DATE BUTTONS
// =====================================================================
function formatDateShort(ds) { const days=['s\u00f8n','man','tir','ons','tor','fre','l\u00f8r']; const d=new Date(ds+'T12:00:00'); return days[d.getDay()]+' '+d.getDate()+'/'+(d.getMonth()+1); }
function buildDateButtons() {
    const row=document.getElementById('dateRow'); row.innerHTML='';
    dates.forEach(function(date) {
        const btn=document.createElement('button'); btn.className='date-btn'+(date===selectedDate?' active':''); btn.textContent=formatDateShort(date);
        btn.onclick=function() { selectedDate=date; document.querySelectorAll('.date-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
            updateDisplay(); drawOverlay(); particles.forEach(p=>{p.history=[];p.age=0;}); windCtx.clearRect(0,0,windCanvas.width,windCanvas.height); };
        row.appendChild(btn);
    });
}

// =====================================================================
// HELPERS
// =====================================================================
function directionName(d) { var dirs=['N','NN\u00d8','N\u00d8','\u00d8N\u00d8','\u00d8','\u00d8S\u00d8','S\u00d8','SS\u00d8','S','SSV','SV','VSV','V','VNV','NV','NNV']; return dirs[Math.round(d/22.5)%16]; }
function beaufortScale(ms) { if(ms<0.3) return {level:0,name:'Stille'}; if(ms<1.6) return {level:1,name:'Flau vind'}; if(ms<3.4) return {level:2,name:'Svak vind'}; if(ms<5.5) return {level:3,name:'Lett bris'}; if(ms<8) return {level:4,name:'Laber bris'}; if(ms<10.8) return {level:5,name:'Frisk bris'}; if(ms<13.9) return {level:6,name:'Liten kuling'}; if(ms<17.2) return {level:7,name:'Stiv kuling'}; if(ms<20.8) return {level:8,name:'Sterk kuling'}; if(ms<24.5) return {level:9,name:'Liten storm'}; if(ms<28.5) return {level:10,name:'Full storm'}; if(ms<32.7) return {level:11,name:'Sterk storm'}; return {level:12,name:'Orkan'}; }

// =====================================================================
// DISPLAY
// =====================================================================
function updateDisplay() {
    const c=map.getCenter(), data=getDataAtLatLng(c.lat,c.lng,selectedDate,currentHour);
    if (!data) return;
    document.getElementById('timeDisplay').textContent=String(currentHour).padStart(2,'0')+':00';
    // Wind
    var bf=beaufortScale(data.speed);
    document.getElementById('wDir').textContent=Math.round(data.dir)+'\u00b0';
    document.getElementById('wSpeed').textContent=data.speed.toFixed(1)+' m/s';
    document.getElementById('wGust').textContent=data.gust.toFixed(1)+' m/s';
    document.getElementById('wFrom').textContent=directionName(data.dir);
    var pct=Math.min(100,(bf.level/12)*100); var fill=document.getElementById('beaufortFill');
    fill.style.width=pct+'%'; fill.style.background=windColorHex(data.speed);
    document.getElementById('beaufortLabel').textContent='Beaufort '+bf.level+' \u2014 '+bf.name;
    // Temp
    document.getElementById('tTemp').textContent=data.temp.toFixed(1)+'\u00b0C';
    document.getElementById('tFeels').textContent=data.feelslike.toFixed(1)+'\u00b0C';
    // Precip
    document.getElementById('pAmount').textContent=data.precip.toFixed(1)+' mm';
    document.getElementById('pProb').textContent=Math.round(data.precipProb)+'%';
    document.getElementById('pSnow').textContent=data.snowfall.toFixed(1)+' cm';
    document.getElementById('pType').textContent=data.snowfall>0.1?'Sn\u00f8':(data.precip>0.1?'Regn':'Ingen');
    // Weather
    document.getElementById('wxIcon').textContent=wmoToEmoji(data.weatherCode);
    document.getElementById('wxDesc').textContent=wmoToDesc(data.weatherCode);
    document.getElementById('wxCode').textContent=data.weatherCode;
    document.getElementById('wxTemp').textContent=data.temp.toFixed(1)+'\u00b0C';
    document.getElementById('wxWind').textContent=data.speed.toFixed(1)+' m/s '+directionName(data.dir);
    document.getElementById('wxPrecip').textContent=data.precip.toFixed(1)+' mm';
}

// =====================================================================
// TAB SWITCHING
// =====================================================================
function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.layer-tab').forEach(t=>t.classList.remove('active'));
    document.querySelector('.layer-tab[data-tab="'+tab+'"]').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    document.getElementById('tab-'+tab).classList.add('active');
    // Legends
    ['wind','temp','precip','weather'].forEach(l => document.getElementById('legend-'+l).style.display = l===tab?'':'none');
    // Wind canvas
    if (tab==='wind') { windCanvas.style.display=''; if(animationEnabled){initParticles();if(animFrameId)cancelAnimationFrame(animFrameId);animate();} }
    else { windCanvas.style.display='none'; windCtx.clearRect(0,0,windCanvas.width,windCanvas.height); }
    drawOverlay();
}
document.querySelectorAll('.layer-tab').forEach(tab => { tab.addEventListener('click', ()=>switchTab(tab.dataset.tab)); });

// =====================================================================
// MODE SWITCHING
// =====================================================================
function switchMode(mode) {
    appMode = mode;
    document.querySelectorAll('.mode-menu-item').forEach(m=>m.classList.toggle('active',m.dataset.mode===mode));
    document.getElementById('modeMenu').classList.remove('open');

    if (mode === 'weather') {
        document.getElementById('weatherPanel').style.display = '';
        document.getElementById('tourPanel').style.display = 'none';
        windCanvas.style.display = activeTab==='wind' ? '' : 'none';
        overlayCanvas.style.display = '';
        // Show relevant weather legend, hide tour legends
        ['wind','temp','precip','weather'].forEach(l => document.getElementById('legend-'+l).style.display = l===activeTab?'':'none');
        document.getElementById('legend-steepness').style.display = 'none';
        // Hide NVE/Kartverket layers when in weather mode
        if (steepnessLayer && map.hasLayer(steepnessLayer)) map.removeLayer(steepnessLayer);
        if (avalancheLayer && map.hasLayer(avalancheLayer)) map.removeLayer(avalancheLayer);
        if (friluftsruterLayer && map.hasLayer(friluftsruterLayer)) map.removeLayer(friluftsruterLayer);
        // Clear topptur route overlay
        if (typeof clearToppturRoute === 'function') clearToppturRoute();
        drawOverlay();
        if (activeTab==='wind' && animationEnabled) { initParticles(); animate(); }
    } else {
        document.getElementById('weatherPanel').style.display = 'none';
        document.getElementById('tourPanel').style.display = '';
        windCanvas.style.display = 'none';
        overlayCanvas.style.display = 'none';
        windCtx.clearRect(0,0,windCanvas.width,windCanvas.height);
        overlayCtx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
        ['wind','temp','precip','weather'].forEach(l => document.getElementById('legend-'+l).style.display='none');
        document.getElementById('legend-steepness').style.display = steepnessVisible ? '' : 'none';
        // Restore NVE/Kartverket layers if they were toggled on
        if (steepnessVisible && steepnessLayer && !map.hasLayer(steepnessLayer)) steepnessLayer.addTo(map);
        if (avalancheVisible && avalancheLayer && !map.hasLayer(avalancheLayer)) avalancheLayer.addTo(map);
        if (friluftsruterVisible && friluftsruterLayer && !map.hasLayer(friluftsruterLayer)) friluftsruterLayer.addTo(map);
        document.getElementById('avalancheInfo').style.display = avalancheVisible ? '' : 'none';
        updateTourStats();
    }
}

// Hamburger menu
document.getElementById('hamburgerBtn').addEventListener('click', function() {
    document.getElementById('modeMenu').classList.toggle('open');
});
document.querySelectorAll('.mode-menu-item').forEach(item => {
    item.addEventListener('click', () => switchMode(item.dataset.mode));
});
// Close menu on outside click
document.addEventListener('click', function(e) {
    if (!e.target.closest('.hamburger') && !e.target.closest('.mode-menu'))
        document.getElementById('modeMenu').classList.remove('open');
});

// =====================================================================
// EVENT LISTENERS
// =====================================================================
document.getElementById('timeSlider').addEventListener('input', function(e) {
    currentHour = parseInt(e.target.value); updateDisplay(); drawOverlay();
    particles.forEach(p=>{p.history=[];}); windCtx.clearRect(0,0,windCanvas.width,windCanvas.height);
});
document.getElementById('densitySlider').addEventListener('input', function(e) {
    particleCount = parseInt(e.target.value); document.getElementById('densityDisplay').textContent = particleCount;
});
document.getElementById('particleToggle').addEventListener('click', function() {
    animationEnabled = !animationEnabled; this.classList.toggle('on', animationEnabled);
    if (animationEnabled) { initParticles(); animate(); }
    else { if(animFrameId) cancelAnimationFrame(animFrameId); windCtx.clearRect(0,0,windCanvas.width,windCanvas.height); }
});

// =====================================================================
// TOPPTUR SYSTEM — dynamic from API (Overpass + Kartverket WFS)
// =====================================================================
let allTours = []; // All tours fetched from APIs
let activeTourTab = 'toppturer';
let selectedTopptur = null;
let toppturRouteLayer = null;
let toppturSummitMarker = null;

// API fetch state
let tourFetchTimer = null;
let tourFetching = false;
let lastTourBounds = null;

function getDifficultyBadge(diff) {
    if (diff === 'enkel') return '<span class="tt-badge tt-badge-easy">Enkel</span>';
    if (diff === 'middels') return '<span class="tt-badge tt-badge-moderate">Middels</span>';
    if (diff === 'krevende') return '<span class="tt-badge tt-badge-hard">Krevende</span>';
    return '<span class="tt-badge tt-badge-season">' + diff + '</span>';
}

function estimateDifficulty(altitude, distance) {
    if (altitude < 1200 && (!distance || distance < 8)) return 'enkel';
    if (altitude < 1600 && (!distance || distance < 14)) return 'middels';
    return 'krevende';
}

// Estimate season from altitude
function estimateSeason(altitude) {
    if (altitude > 1800) return 'Apr\u2013Jun';
    if (altitude > 1400) return 'Mar\u2013Jun';
    if (altitude > 1000) return 'Feb\u2013Mai';
    return 'Jan\u2013Apr';
}

// Calculate route distance from coordinates
function calcRouteDistance(route) {
    if (!route || route.length < 2) return null;
    let dist = 0;
    for (let i = 1; i < route.length; i++) {
        dist += haversine(route[i-1][0], route[i-1][1], route[i][0], route[i][1]);
    }
    return Math.round(dist * 10) / 10;
}

// Estimate elevation gain from route endpoints (rough)
function estimateElevationGain(route, peakAlt) {
    if (!route || route.length < 2 || !peakAlt) return null;
    // Estimate start altitude as peak minus rough gain based on distance
    const dist = calcRouteDistance(route);
    if (!dist) return null;
    // Very rough estimate: typical Norwegian terrain
    return Math.round(Math.min(peakAlt - 100, dist * 120));
}

// Get tours visible in current map viewport
function getVisibleTours() {
    const bounds = map.getBounds();
    const pad = 0.15;
    const s = bounds.getSouth() - pad, n = bounds.getNorth() + pad;
    const w = bounds.getWest() - pad, e = bounds.getEast() + pad;
    return allTours.filter(t => t.lat >= s && t.lat <= n && t.lng >= w && t.lng <= e)
        .sort((a, b) => {
            // Tours with routes first, then by altitude
            if (a.route && !b.route) return -1;
            if (!a.route && b.route) return 1;
            return b.altitude - a.altitude;
        });
}

// =====================================================================
// FETCH SKI TOURING ROUTES FROM OVERPASS API (GPS-precise)
// =====================================================================
async function fetchSkiTourRoutes(s, w, n, e) {
    // Query for ski touring routes + peaks in one request
    const query = '[out:json][timeout:25];(' +
        'way["piste:type"="skitour"](' + s + ',' + w + ',' + n + ',' + e + ');' +
        'relation["route"="ski"](' + s + ',' + w + ',' + n + ',' + e + ');' +
        'way["piste:type"="downhill"]["sport"~"ski_touring|backcountry"](' + s + ',' + w + ',' + n + ',' + e + ');' +
        'node["natural"="peak"](' + s + ',' + w + ',' + n + ',' + e + ');' +
        ');out geom;';

    const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
    return await res.json();
}

// =====================================================================
// FETCH ROUTES FROM KARTVERKET WFS (official trail data)
// =====================================================================
async function fetchKartverketRoutes(s, w, n, e) {
    try {
        // Try Kartverket WFS for Skiloype layer
        const bbox = s + ',' + w + ',' + n + ',' + e + ',EPSG:4326';
        const url = 'https://wfs.geonorge.no/skwms1/wfs.friluftsruter2?' +
            'service=WFS&version=2.0.0&request=GetFeature' +
            '&typeNames=Skiloype' +
            '&outputFormat=application/json' +
            '&bbox=' + bbox +
            '&srsName=EPSG:4326&count=50';
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const json = await res.json();
        if (!json.features) return [];
        return json.features;
    } catch(e) {
        console.warn('Kartverket WFS unavailable:', e.message);
        return [];
    }
}

// =====================================================================
// MAIN TOUR FETCH — combines all API sources
// =====================================================================
async function fetchTourData() {
    if (tourFetching) return;
    const bounds = map.getBounds();
    const zoom = map.getZoom();

    // Only fetch at reasonable zoom levels
    if (zoom < 8) {
        allTours = [];
        if (appMode === 'tour' && activeTourTab === 'toppturer' && !selectedTopptur) renderToppturList();
        return;
    }

    // Skip if bounds haven't changed significantly
    if (lastTourBounds) {
        const cOld = lastTourBounds.getCenter(), cNew = bounds.getCenter();
        if (haversine(cOld.lat, cOld.lng, cNew.lat, cNew.lng) < 3 && Math.abs(zoom - (lastTourBounds._zoom || 0)) < 2) return;
    }

    tourFetching = true;
    const s = bounds.getSouth().toFixed(4), w = bounds.getWest().toFixed(4);
    const n = bounds.getNorth().toFixed(4), e = bounds.getEast().toFixed(4);

    const tours = [];
    let idCounter = 1;

    try {
        // Fetch from Overpass (peaks + ski routes)
        const osmData = await fetchSkiTourRoutes(s, w, n, e);
        const elements = osmData.elements || [];

        // Separate peaks and routes
        const peaks = elements.filter(el => el.type === 'node' && el.tags && el.tags.natural === 'peak' && el.tags.name && el.tags.ele && parseFloat(el.tags.ele) >= 800);
        const routes = elements.filter(el => (el.type === 'way' || el.type === 'relation') && el.geometry && el.geometry.length >= 2);

        // Build route objects from ski touring ways/relations
        for (const rt of routes) {
            const coords = rt.geometry.map(g => [g.lat, g.lon]);
            if (coords.length < 2) continue;

            const name = (rt.tags && rt.tags.name) || 'Skitur';
            const dist = calcRouteDistance(coords);

            // Find highest point along route for altitude
            let maxLat = coords[coords.length - 1][0], maxLng = coords[coords.length - 1][1];
            // Check if a named peak is near the route endpoint
            let peakAlt = null, peakName = null;
            const endPt = coords[coords.length - 1];
            for (const pk of peaks) {
                const d = haversine(endPt[0], endPt[1], pk.lat, pk.lon);
                if (d < 1.5) {
                    peakAlt = Math.round(parseFloat(pk.tags.ele));
                    peakName = pk.tags.name;
                    maxLat = pk.lat;
                    maxLng = pk.lon;
                    break;
                }
            }
            // Also check start point
            if (!peakAlt) {
                const startPt = coords[0];
                for (const pk of peaks) {
                    const d = haversine(startPt[0], startPt[1], pk.lat, pk.lon);
                    if (d < 1.5) {
                        peakAlt = Math.round(parseFloat(pk.tags.ele));
                        peakName = pk.tags.name;
                        maxLat = pk.lat;
                        maxLng = pk.lon;
                        break;
                    }
                }
            }

            const alt = peakAlt || 0;
            const displayName = peakName ? peakName + (name !== 'Skitur' && name !== peakName ? ' (' + name + ')' : '') : name;
            const area = (rt.tags && (rt.tags['is_in'] || rt.tags['is_in:municipality'])) || 'Vestland';
            const elGain = estimateElevationGain(coords, alt);
            const pisteType = rt.tags && rt.tags['piste:type'];

            tours.push({
                id: idCounter++,
                name: displayName,
                altitude: alt,
                area: area,
                distance: dist,
                elevationGain: elGain,
                difficulty: estimateDifficulty(alt, dist),
                season: estimateSeason(alt),
                aspect: null,
                lat: maxLat, lng: maxLng,
                route: coords,
                img: null,
                description: 'Skiturrute fra OpenStreetMap' + (pisteType ? ' (' + pisteType + ')' : '') + '. ' + (dist ? dist + ' km' : '') + (alt ? ', topph\u00f8yde ' + alt + ' moh.' : '') + ' GPS-presis rute.',
                tips: 'Sjekk lokale forhold og skredvarsel f\u00f8r turen. Ruten er hentet fra OpenStreetMap og b\u00f8r verifiseres i felt.',
                source: 'osm-route'
            });
        }

        // Add peaks that don't have a nearby route
        for (const pk of peaks) {
            const alt = Math.round(parseFloat(pk.tags.ele));
            // Skip if we already have a route near this peak
            const hasRoute = tours.some(t => t.route && haversine(pk.lat, pk.lon, t.lat, t.lng) < 1.5);
            if (hasRoute) continue;

            tours.push({
                id: idCounter++,
                name: pk.tags.name,
                altitude: alt,
                area: pk.tags['is_in'] || pk.tags['is_in:municipality'] || 'Vestland',
                distance: null,
                elevationGain: null,
                difficulty: estimateDifficulty(alt),
                season: estimateSeason(alt),
                aspect: null,
                lat: pk.lat, lng: pk.lon,
                route: null,
                img: null,
                description: 'Fjelltopp fra OpenStreetMap (' + alt + ' moh). Ingen GPS-rute tilgjengelig enn\u00e5.',
                tips: 'Sjekk lokale forhold og skredvarsel f\u00f8r turen.',
                source: 'osm-peak'
            });
        }
    } catch(e) {
        console.warn('Overpass tour fetch failed:', e);
    }

    // Also try Kartverket WFS
    try {
        const wfsFeatures = await fetchKartverketRoutes(s, w, n, e);
        for (const feat of wfsFeatures) {
            if (!feat.geometry || !feat.geometry.coordinates) continue;
            let coords;
            if (feat.geometry.type === 'LineString') {
                coords = feat.geometry.coordinates.map(c => [c[1], c[0]]);
            } else if (feat.geometry.type === 'MultiLineString') {
                coords = feat.geometry.coordinates[0].map(c => [c[1], c[0]]);
            } else continue;
            if (coords.length < 2) continue;

            const name = (feat.properties && (feat.properties.navn || feat.properties.tuNavn || feat.properties.rutNavn)) || 'Kartverket-rute';
            const dist = calcRouteDistance(coords);
            // Check for duplicates (near existing routes)
            const mid = coords[Math.floor(coords.length / 2)];
            const isDupe = tours.some(t => t.route && haversine(mid[0], mid[1], t.lat, t.lng) < 0.5);
            if (isDupe) continue;

            tours.push({
                id: idCounter++,
                name: name,
                altitude: 0,
                area: (feat.properties && feat.properties.kommune) || 'Norge',
                distance: dist,
                elevationGain: null,
                difficulty: 'middels',
                season: 'Jan\u2013Apr',
                aspect: null,
                lat: coords[coords.length - 1][0],
                lng: coords[coords.length - 1][1],
                route: coords,
                img: null,
                description: 'Skil\u00f8ype/turute fra Kartverkets nasjonale rutebase. ' + (dist ? dist + ' km. ' : '') + 'GPS-presis rute.',
                tips: 'Offisiell rute fra Kartverkets friluftsrutedatabase.',
                source: 'kartverket'
            });
        }
    } catch(e) {
        console.warn('Kartverket WFS fetch failed:', e);
    }

    allTours = tours;
    lastTourBounds = bounds;
    lastTourBounds._zoom = zoom;

    // Refresh list if viewing toppturer
    if (appMode === 'tour' && activeTourTab === 'toppturer' && !selectedTopptur) {
        renderToppturList();
    }

    tourFetching = false;
}

function renderToppturList() {
    const list = document.getElementById('toppturList');
    const detail = document.getElementById('toppturDetail');
    list.style.display = ''; detail.style.display = 'none'; detail.classList.remove('active');
    selectedTopptur = null; clearToppturRoute();

    const visible = getVisibleTours();

    if (visible.length === 0) {
        const loading = tourFetching ? '<br><span style="color:#7ec8e3;">Henter turer fra API...</span>' : '';
        list.innerHTML = '<div style="text-align:center;padding:20px 10px;color:#555;font-size:12px;">' +
            '<div style="font-size:28px;margin-bottom:8px;">\u26F0\uFE0F</div>' +
            'Ingen toppturer funnet i dette omr\u00e5det.' + loading + '<br><br>' +
            '<span style="color:#666;">Flytt kartet til et fjellomr\u00e5de for \u00e5 se tilgjengelige turer, eller zoom ut.</span></div>';
        return;
    }

    const withRoute = visible.filter(t => t.route).length;
    const peaksOnly = visible.filter(t => !t.route).length;
    const kvCount = visible.filter(t => t.source === 'kartverket').length;

    let header = '<div style="font-size:10px;color:#555;margin-bottom:8px;padding:0 2px;">' +
        '\uD83D\uDCCD ' + visible.length + ' turer i kartutsnitt';
    if (withRoute > 0) header += ' (' + withRoute + ' med GPS-rute';
    if (kvCount > 0) header += ', ' + kvCount + ' fra Kartverket';
    if (withRoute > 0) header += ')';
    if (tourFetching) header += ' <span style="color:#7ec8e3;">oppdaterer...</span>';
    header += '</div>';

    list.innerHTML = header + visible.map(t => {
        const hasRoute = t.route && t.route.length >= 2;
        const isKV = t.source === 'kartverket';
        const borderColor = hasRoute ? (isKV ? 'rgba(46,204,113,0.5)' : 'rgba(243,156,18,0.5)') : 'rgba(155,89,182,0.4)';
        const borderStyle = 'border-left:3px solid ' + borderColor + ';';
        const icon = hasRoute ? '\u26F7\uFE0F' : '\u26F0\uFE0F';
        const sourceLabel = isKV ? 'Kartverket' : 'OSM';
        const sourceColor = isKV ? '#2ecc71' : '#9b59b6';

        let statsHtml = '';
        if (t.elevationGain) statsHtml += '<span class="tt-stat">\u2195 <span class="tt-stat-val">' + t.elevationGain + ' m</span></span>';
        if (t.distance) statsHtml += '<span class="tt-stat">\u27F6 <span class="tt-stat-val">' + t.distance + ' km</span></span>';
        if (t.altitude) statsHtml += '<span class="tt-stat">\u2B06 <span class="tt-stat-val">' + t.altitude + ' m</span></span>';

        const imgHtml = t.img
            ? '<img class="tt-img" src="' + t.img + '" alt="' + t.name + '" loading="lazy" onerror="this.outerHTML=\'<div class=tt-img-placeholder>' + icon + '</div>\'">'
            : '<div class="tt-img-placeholder">' + icon + (hasRoute ? '<div style="font-size:8px;margin-top:2px;color:rgba(255,255,255,0.5);">GPS</div>' : '') + '</div>';

        return '<div class="topptur-card" style="' + borderStyle + '" onclick="showToppturDetail(' + t.id + ')">' +
            imgHtml +
            '<div class="tt-body">' +
            '<div class="tt-header">' +
                '<span class="tt-icon">' + icon + '</span>' +
                '<div><div class="tt-title">' + t.name + (t.altitude ? ' (' + t.altitude + ' moh)' : '') + '</div>' +
                '<div class="tt-subtitle">' + t.area + ' \u00b7 <span style="color:' + sourceColor + ';">' + sourceLabel + '</span></div></div>' +
            '</div>' +
            '<div class="tt-stats">' + statsHtml + '</div>' +
            '<div class="tt-badges">' +
                getDifficultyBadge(t.difficulty) +
                (t.season ? '<span class="tt-badge tt-badge-season">' + t.season + '</span>' : '') +
                (hasRoute ? '<span class="tt-badge" style="background:rgba(46,204,113,0.15);color:#2ecc71;">GPS-rute</span>' : '') +
            '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

function findTourById(id) {
    return allTours.find(x => x.id === id);
}

function showToppturDetail(id) {
    const t = findTourById(id);
    if (!t) return;
    selectedTopptur = t;

    const list = document.getElementById('toppturList');
    const detail = document.getElementById('toppturDetail');
    list.style.display = 'none';
    detail.style.display = 'block'; detail.classList.add('active');

    const hasRoute = t.route && t.route.length >= 2;
    const icon = hasRoute ? '\u26F7\uFE0F' : '\u26F0\uFE0F';
    const isKV = t.source === 'kartverket';
    const sourceLabel = isKV ? 'Kartverket' : 'OpenStreetMap';
    const sourceColor = isKV ? '#2ecc71' : '#9b59b6';

    let statsHtml = '';
    if (t.altitude) statsHtml += '<div class="tt-detail-stat"><div class="ds-label">H\u00f8yde</div><div class="ds-val">' + t.altitude + ' m</div></div>';
    if (t.elevationGain) statsHtml += '<div class="tt-detail-stat"><div class="ds-label">Stigning</div><div class="ds-val">' + t.elevationGain + ' m</div></div>';
    if (t.distance) statsHtml += '<div class="tt-detail-stat"><div class="ds-label">Distanse</div><div class="ds-val">' + t.distance + ' km</div></div>';
    if (t.aspect) statsHtml += '<div class="tt-detail-stat"><div class="ds-label">Eksposisjon</div><div class="ds-val">' + t.aspect + '</div></div>';
    statsHtml += '<div class="tt-detail-stat"><div class="ds-label">Kilde</div><div class="ds-val" style="color:' + sourceColor + ';">' + sourceLabel + '</div></div>';
    if (hasRoute) statsHtml += '<div class="tt-detail-stat"><div class="ds-label">Rute</div><div class="ds-val" style="color:#2ecc71;">GPS-presis (' + t.route.length + ' pkt)</div></div>';

    let descHtml = '<div style="margin-bottom:8px;">' + t.description + '</div>';
    if (t.tips) descHtml += '<div style="color:#7ec8e3;font-size:11px;font-weight:600;">Tips:</div><div style="font-size:11px;color:#888;">' + t.tips + '</div>';

    let actionsHtml = '<button class="tour-btn" onclick="showToppturOnMap(' + t.id + ')">\uD83D\uDDFA\uFE0F Vis p\u00e5 kart</button>';
    if (hasRoute) {
        actionsHtml += '<button class="tour-btn" onclick="planFromTopptur(' + t.id + ')">\u270E Planlegg rute</button>';
    }

    const detailImgHtml = t.img
        ? '<img class="tt-detail-img" src="' + t.img + '" alt="' + t.name + '" onerror="this.style.display=\'none\'">'
        : '';

    detail.innerHTML =
        '<button class="tt-detail-back" onclick="renderToppturList()">\u2190 Tilbake til listen</button>' +
        detailImgHtml +
        '<div class="tt-detail-name">' + icon + ' ' + t.name + '</div>' +
        '<div class="tt-detail-area">' + t.area + ' &middot; ' + getDifficultyBadge(t.difficulty) + '</div>' +
        '<div class="tt-detail-stats">' + statsHtml + '</div>' +
        '<div class="tt-detail-desc">' + descHtml + '</div>' +
        '<div class="tt-detail-actions">' + actionsHtml + '</div>';

    showToppturOnMap(t.id);
}

function clearToppturRoute() {
    if (toppturRouteLayer) { map.removeLayer(toppturRouteLayer); toppturRouteLayer = null; }
    if (toppturSummitMarker) { map.removeLayer(toppturSummitMarker); toppturSummitMarker = null; }
}

function showToppturOnMap(id) {
    const t = findTourById(id);
    if (!t) return;
    clearToppturRoute();

    // Draw route if available (solid line for GPS routes, dashed for approximate)
    if (t.route && t.route.length >= 2) {
        const routeStyle = t.source === 'kartverket'
            ? { color: '#2ecc71', weight: 3, opacity: 0.9 }
            : { color: '#f39c12', weight: 3, opacity: 0.9 };
        toppturRouteLayer = L.polyline(t.route, routeStyle).addTo(map);
    }

    // Summit/endpoint marker
    const markerColor = t.route ? 'rgba(243,156,18,0.95)' : 'rgba(155,89,182,0.95)';
    const markerIcon = t.route ? '\u26F7' : '\u26F0';
    const altLabel = t.altitude ? ' ' + t.altitude + 'm' : '';
    toppturSummitMarker = L.marker([t.lat, t.lng], {
        icon: L.divIcon({
            className: '',
            html: '<div style="background:' + markerColor + ';color:#fff;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.3);">' + markerIcon + ' ' + t.name + altLabel + '</div>',
            iconSize: [0, 0], iconAnchor: [-5, 15]
        })
    }).addTo(map);

    // Pan map to tour area
    if (t.route && t.route.length >= 2) {
        map.fitBounds(toppturRouteLayer.getBounds().pad(0.3));
    } else {
        map.setView([t.lat, t.lng], 13);
    }
}

function planFromTopptur(id) {
    const t = findTourById(id);
    if (!t || !t.route) return;
    switchTourTab('planlegg');
    clearTourRoute();
    clearToppturRoute();
    t.route.forEach(pt => addTourWaypoint(pt[0], pt[1]));
}

// Tour section tab switching
function switchTourTab(tab) {
    activeTourTab = tab;
    document.querySelectorAll('.tour-section-tab').forEach(t => t.classList.toggle('active', t.dataset.tourtab === tab));
    document.querySelectorAll('.tour-section-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tourtab-' + tab).classList.add('active');

    if (tab === 'toppturer') {
        if (!selectedTopptur) renderToppturList();
        // Trigger tour data fetch for current area
        clearTimeout(tourFetchTimer);
        tourFetchTimer = setTimeout(fetchTourData, 300);
    }
    if (tab === 'planlegg') {
        clearToppturRoute();
    }
}

document.querySelectorAll('.tour-section-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTourTab(tab.dataset.tourtab));
});

// Auto-refresh tour list when map moves (if in tour/toppturer mode)
map.on('moveend zoomend', function() {
    if (appMode === 'tour' && activeTourTab === 'toppturer' && !selectedTopptur) {
        renderToppturList();
        // Debounced API fetch
        clearTimeout(tourFetchTimer);
        tourFetchTimer = setTimeout(fetchTourData, 800);
    }
});

// Render list on initial load
renderToppturList();
// Initial tour data fetch
setTimeout(fetchTourData, 1500);

// Tour buttons
document.getElementById('btnDrawRoute').addEventListener('click', function() { tourDrawing=!tourDrawing; this.classList.toggle('active',tourDrawing); });
document.getElementById('btnUndoPoint').addEventListener('click', undoTourPoint);
document.getElementById('btnClearRoute').addEventListener('click', clearTourRoute);
document.getElementById('toggleSteepness').addEventListener('click', toggleSteepnessLayer);
document.getElementById('toggleAvalanche').addEventListener('click', toggleAvalancheLayer);

// Kartverket Friluftsruter WMS toggle
function toggleFriluftsruterLayer() {
    friluftsruterVisible = !friluftsruterVisible;
    document.getElementById('toggleFriluftsruter').classList.toggle('on', friluftsruterVisible);
    if (friluftsruterVisible && !friluftsruterLayer) {
        friluftsruterLayer = L.tileLayer.wms('https://wms.geonorge.no/skwms1/wms.friluftsruter2', {
            layers: 'Fotrute,Skiloype,Sykkelrute,Annen_rute',
            format: 'image/png', transparent: true, opacity: 0.7,
            attribution: 'Friluftsruter: Kartverket', maxZoom: 18, zIndex: 410
        }).addTo(map);
    } else if (friluftsruterVisible && friluftsruterLayer) {
        friluftsruterLayer.addTo(map);
    } else if (!friluftsruterVisible && friluftsruterLayer) {
        map.removeLayer(friluftsruterLayer);
    }
}
document.getElementById('toggleFriluftsruter').addEventListener('click', toggleFriluftsruterLayer);

// Mobile
var controlsVisible = true;
function getActivePanel() { return appMode === 'weather' ? document.getElementById('weatherPanel') : document.getElementById('tourPanel'); }
document.getElementById('controlsToggle').addEventListener('click', function() {
    controlsVisible = !controlsVisible;
    const panel = getActivePanel();
    if (panel) panel.classList.toggle('collapsed', !controlsVisible);
});
function autoCollapseOnMobile() {
    if (window.innerWidth<=600) {
        controlsVisible=false;
        const panel = getActivePanel();
        if (panel) panel.classList.add('collapsed');
    }
}

// Mobile performance
if (window.innerWidth <= 600) { particleCount=300; document.getElementById('densitySlider').value=300; document.getElementById('densityDisplay').textContent='300'; }

// =====================================================================
// START
// =====================================================================
loadData();
