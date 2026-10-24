/* 3D dispatch yard: animates one replication of the twin (Three.js r128).
 *
 * What you see is driven by the simulation, day by day:
 *   - boxes on the staging floor = orders waiting for dispatch (1 box = 4 orders)
 *   - open dock doors           = dispatch capacity that day (8 orders per truck)
 *   - trucks backing in/leaving = orders shipped that day
 * Usage: const yard = DispatchYard.mount(element, { twin, cal, onDay });
 *        yard.setScenario(scenario, { startDay });  yard.play(); yard.pause(); yard.setSpeed(x); yard.seek(day)
 */
(function (root) {
  "use strict";

  const ORDERS_PER_BOX = 4, ORDERS_PER_TRUCK = 8, DOORS = 12, SECONDS_PER_DAY = 4;
  const C = {
    asphalt: 0x6c727a, line: 0xf4f5f2, road: 0x5c6168, wall: 0xf3f4f2, floor: 0xd8dcdb, trim: 0xc9cdcf,
    door: 0x2f3439, doorOpen: 0x14181b, rackUp: 0xe58a2e, rackBeam: 0x2d6cb4, carton: 0xc79a5c, cartonDark: 0xa9783f,
    pallet: 0xb58a55, trailer: 0xf7f8f8, stripe: 0x2a78d6, cab: 0xf1f2f2, glass: 0x26313a, tyre: 0x1d2024, light: 0x3ccf6e,
  };

  function mount(el, opts) {
    const THREE = root.THREE, T = opts.twin, CAL = opts.cal;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, root.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("aria-hidden", "true");

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 1000);
    const target = new THREE.Vector3(0, 0, -2);
    const view = { r: 128, polar: 0.84, az: 0.55 };
    function placeCamera() {
      camera.position.set(
        target.x + view.r * Math.sin(view.polar) * Math.sin(view.az),
        target.y + view.r * Math.cos(view.polar),
        target.z + view.r * Math.sin(view.polar) * Math.cos(view.az));
      camera.lookAt(target);
    }

    // ---- light ---------------------------------------------------------------
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8b9096, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(-50, 90, 45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 70, bottom: -70, near: 10, far: 260 });
    sun.shadow.bias = -0.0008;
    scene.add(sun);

    // ---- helpers -------------------------------------------------------------
    const mats = {};
    function mat(color, extra) {
      const key = color + JSON.stringify(extra || {});
      if (!mats[key]) mats[key] = new THREE.MeshLambertMaterial(Object.assign({ color: color }, extra || {}));
      return mats[key];
    }
    function box(w, h, d, color, x, y, z, parent, shadow) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === "number" ? mat(color) : color);
      m.position.set(x, y + h / 2, z);
      m.castShadow = shadow !== false; m.receiveShadow = true;
      (parent || scene).add(m);
      return m;
    }
    function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

    // ---- ground, road, markings ---------------------------------------------
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(320, 240), mat(C.asphalt));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(320, 18), mat(C.road));
    road.rotation.x = -Math.PI / 2; road.position.set(0, 0.02, 34); road.receiveShadow = true; scene.add(road);
    for (let x = -150; x < 150; x += 8) box(4, 0.02, 0.35, C.line, x, 0.03, 34, null, false);
    for (let i = 0; i < DOORS; i++) {     // bay lines in front of the docks
      const x = doorX(i) - 3.3;
      box(0.3, 0.02, 16, C.line, x, 0.03, 4.5, null, false);
    }
    box(0.3, 0.02, 16, C.line, doorX(DOORS - 1) + 3.3, 0.03, 4.5, null, false);
    for (let i = 0; i < 6; i++) box(0.3, 0.02, 15, C.line, -78 + i * 6, 0.03, 4, null, false);  // trailer parking

    // ---- warehouse -----------------------------------------------------------
    const W = { x0: -42, x1: 42, z0: -38, z1: -4, h: 5.6, t: 0.7 };
    function doorX(i) { return -36.3 + i * 6.6; }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W.x1 - W.x0, W.z1 - W.z0), mat(C.floor));
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.06, (W.z0 + W.z1) / 2); floor.receiveShadow = true; scene.add(floor);
    box(W.x1 - W.x0, W.h, W.t, C.wall, 0, 0, W.z0);                          // back
    box(W.t, W.h, W.z1 - W.z0, C.wall, W.x0, 0, (W.z0 + W.z1) / 2);          // left
    box(W.t, W.h, W.z1 - W.z0, C.wall, W.x1, 0, (W.z0 + W.z1) / 2);          // right
    // front wall with dock openings
    const doorW = 3.6, doorH = 4.3;
    let prev = W.x0;
    for (let i = 0; i < DOORS; i++) {
      const a = doorX(i) - doorW / 2, b = doorX(i) + doorW / 2;
      box(a - prev, W.h, W.t, C.wall, (prev + a) / 2, 0, W.z1);
      box(doorW, W.h - doorH, W.t, C.wall, doorX(i), doorH, W.z1);
      prev = b;
    }
    box(W.x1 - prev, W.h, W.t, C.wall, (prev + W.x1) / 2, 0, W.z1);
    box(W.x1 - W.x0 + 0.6, 0.35, 0.9, C.trim, 0, W.h, W.z1);                  // parapet trim
    box(W.x1 - W.x0 + 0.6, 0.35, 0.9, C.trim, 0, W.h, W.z0);
    box(0.5, 4.2, 12, C.wall, -10, 0, -32);                                   // interior partitions
    box(0.5, 4.2, 12, C.wall, 14, 0, -32);
    // dock shutters and dock-levellers; state set each frame
    const doors = [];
    for (let i = 0; i < DOORS; i++) {
      const shutter = box(doorW - 0.1, doorH, 0.25, mat(C.door), doorX(i), 0, W.z1 + 0.5, null, false);
      const lamp = box(0.5, 0.5, 0.2, mat(0x555a5f), doorX(i) + doorW / 2 + 0.6, 4.6, W.z1 + 0.45, null, false);
      box(doorW + 0.6, 1.1, 1.4, mat(0x4b5056), doorX(i), 0, W.z1 + 1.0);     // dock bumper block
      doors.push({ shutter: shutter, lamp: lamp, open: 0 });
    }

    // storage racks (static)
    const r = rng(7);
    const rackRows = [-35.5, -33, -30, -27.5];
    const uprightGeo = new THREE.BoxGeometry(0.18, 5.4, 1.2), beamGeo = new THREE.BoxGeometry(2.6, 0.16, 0.12);
    const cartonGeo = new THREE.BoxGeometry(1.0, 0.9, 0.95);
    const ups = [], beams = [], cartons = [];
    rackRows.forEach(function (z) {
      for (let x = -40; x <= 40; x += 2.8) {
        if (Math.abs(x + 10) < 1.6 || Math.abs(x - 14) < 1.6) continue;
        ups.push([x, 2.7, z]);
        [1.7, 3.4, 5.1].forEach(function (h) {
          if (x + 2.8 <= 40) { beams.push([x + 1.4, h, z - 0.55]); beams.push([x + 1.4, h, z + 0.55]); }
          for (let k = 0; k < 2; k++) if (x + 2.8 <= 40 && r() < 0.78) cartons.push([x + 0.75 + k * 1.3, h + 0.53, z]);
        });
        if (x + 2.8 <= 40) for (let k = 0; k < 2; k++) if (r() < 0.6) cartons.push([x + 0.75 + k * 1.3, 0.53, z]);
      }
    });
    function instanced(geo, color, list) {
      const m = new THREE.InstancedMesh(geo, mat(color), list.length);
      const o = new THREE.Object3D();
      list.forEach(function (p, i) { o.position.set(p[0], p[1], p[2]); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
      m.castShadow = true; m.receiveShadow = true; scene.add(m); return m;
    }
    instanced(uprightGeo, C.rackUp, ups);
    instanced(beamGeo, C.rackBeam, beams);
    instanced(cartonGeo, C.carton, cartons);

    // staging floor marking + backlog boxes (dynamic)
    const stage = { x0: -24, cols: 30, rows: 6, layers: 7, dx: 1.62, dz: 1.5, z0: -14 };
    const sw = stage.cols * stage.dx + 1, sd = stage.rows * stage.dz + 1, scx = stage.x0 + (stage.cols * stage.dx) / 2 - 0.8, scz = stage.z0 - (stage.rows * stage.dz) / 2 + 0.7;
    box(sw, 0.02, sd, mat(0xc4cac8), scx, 0.07, scz, null, false);                       // staging lane
    [[sw, 0.25, scx, scz - sd / 2], [sw, 0.25, scx, scz + sd / 2]].forEach(function (l) { box(l[0], 0.03, l[1], mat(0xf1b434), l[2], 0.08, l[3], null, false); });
    [[scx - sw / 2], [scx + sw / 2]].forEach(function (l) { box(0.25, 0.03, sd, mat(0xf1b434), l[0], 0.08, scz, null, false); });
    const MAX_BOXES = stage.cols * stage.rows * stage.layers;
    // own material: it needs the per-instance colour shader variant
    const backlogMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.35, 1.0, 1.25), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_BOXES);
    backlogMesh.castShadow = true; backlogMesh.receiveShadow = true;
    backlogMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOXES * 3), 3);
    const tmp = new THREE.Object3D(), cA = new THREE.Color(C.carton), cB = new THREE.Color(C.cartonDark);
    const slots = [];
    for (let l = 0; l < stage.layers; l++)
      for (let row = 0; row < stage.rows; row++)
        for (let c = 0; c < stage.cols; c++) slots.push([stage.x0 + c * stage.dx, 0.08 + l * 1.02, stage.z0 - row * stage.dz]);
    // fill a layer front-to-back, then stack the next one
    slots.forEach(function (_, i) { (i % 3 ? cA : cB).toArray(backlogMesh.instanceColor.array, i * 3); });
    scene.add(backlogMesh);
    function showBoxes(nFloat) {
      const n = Math.min(MAX_BOXES, Math.floor(nFloat)), frac = nFloat - Math.floor(nFloat);
      for (let i = 0; i < MAX_BOXES; i++) {
        const s = slots[i];
        let sc = i < n ? 1 : (i === n ? frac : 0);
        tmp.position.set(s[0], s[1] + 0.5 * sc, s[2]);
        tmp.scale.set(sc || 1e-4, sc || 1e-4, sc || 1e-4);
        tmp.updateMatrix(); backlogMesh.setMatrixAt(i, tmp.matrix);
      }
      backlogMesh.instanceMatrix.needsUpdate = true;
    }

    // parked trailers (static, left yard)
    const trailerTex = (function () {
      const c = document.createElement("canvas"); c.width = 1024; c.height = 256;
      const g = c.getContext("2d");
      g.fillStyle = "#f7f8f8"; g.fillRect(0, 0, 1024, 256);
      g.fillStyle = "#2a78d6"; g.fillRect(0, 214, 1024, 18);
      g.fillStyle = "#1c4f8f"; g.font = "700 92px 'Barlow Condensed', 'Arial Narrow', sans-serif"; g.textBaseline = "middle";
      g.fillText("DataCo", 60, 110);
      g.fillStyle = "#7a8188"; g.font = "500 34px 'IBM Plex Sans', Arial, sans-serif"; g.fillText("Fulfilment", 64, 172);
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
    })();
    const sideMat = new THREE.MeshLambertMaterial({ map: trailerTex });
    function makeTruck(withCab) {
      const g = new THREE.Group();
      // local frame: rear of trailer at origin, body along +z, cab at the +z end
      const L = 12.5, Wd = 2.55, H = 3.4, base = 1.15;
      const trailerMats = [sideMat, sideMat, mat(C.trailer), mat(C.trailer), mat(C.trailer), mat(C.trailer)];
      const t = new THREE.Mesh(new THREE.BoxGeometry(Wd, H, L), trailerMats);
      t.position.set(0, base + H / 2, L / 2); t.castShadow = true; t.receiveShadow = true; g.add(t);
      t.geometry.rotateY(0);     // side faces carry the logo
      const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.45, 14); wheelGeo.rotateZ(Math.PI / 2);
      [[1.2], [2.4], [L - 0.2]].forEach(function (p) {
        [-1.05, 1.05].forEach(function (sx) { const w = new THREE.Mesh(wheelGeo, mat(C.tyre)); w.position.set(sx, 0.55, p[0]); w.castShadow = true; g.add(w); });
      });
      if (withCab) {
        const cab = new THREE.Group(); cab.position.set(0, 0, L + 0.4); g.add(cab);
        box(2.5, 2.9, 2.6, C.cab, 0, 1.0, 1.4, cab);
        box(2.52, 1.0, 0.1, C.glass, 0, 2.6, 2.72, cab, false);              // windscreen
        box(2.5, 0.9, 3.2, mat(0x3a3f45), 0, 0.3, 1.2, cab);                  // chassis
        [0.6, 2.3].forEach(function (z) { [-1.05, 1.05].forEach(function (sx) { const w = new THREE.Mesh(wheelGeo, mat(C.tyre)); w.position.set(sx, 0.55, z); w.castShadow = true; cab.add(w); }); });
      } else {
        box(0.3, 1.1, 0.3, mat(0x50565c), 0, 0, L - 1.5, g);                  // landing legs
      }
      scene.add(g);
      return g;
    }
    [[-78, 3], [-72, 3], [-66, 3], [-54, 3]].forEach(function (p, i) {
      const tr = makeTruck(false); tr.position.set(p[0] + 3, 0, -3); tr.rotation.y = 0;
      if (i === 3) tr.visible = false;
    });

    // trucks: one per door, reused every day
    const trucks = [];
    for (let i = 0; i < DOORS; i++) { const tr = makeTruck(true); tr.visible = false; trucks.push(tr); }

    // ---- truck paths -----------------------------------------------------------
    const v = new THREE.Vector3();
    function bez(p0, p1, p2, p3, s, out) {
      const u = 1 - s;
      out.x = u * u * u * p0[0] + 3 * u * u * s * p1[0] + 3 * u * s * s * p2[0] + s * s * s * p3[0];
      out.z = u * u * u * p0[1] + 3 * u * u * s * p1[1] + 3 * u * s * s * p2[1] + s * s * s * p3[1];
      return out;
    }
    function bezT(p0, p1, p2, p3, s) {
      const u = 1 - s;
      return [3 * u * u * (p1[0] - p0[0]) + 6 * u * s * (p2[0] - p1[0]) + 3 * s * s * (p3[0] - p2[0]),
              3 * u * u * (p1[1] - p0[1]) + 6 * u * s * (p2[1] - p1[1]) + 3 * s * s * (p3[1] - p2[1])];
    }
    const ease = (s) => s * s * (3 - 2 * s);
    const DOCK_Z = W.z1 + 1.8, IN_Z = 30.5, OUT_Z = 37.5;
    // phases as day fractions: in (forward), reverse into dock, load, depart
    const PH = [0.10, 0.11, 0.20, 0.15];
    function placeTruck(tr, door, f) {
      const x = doorX(door);
      let s, T, forward;
      if (f < PH[0]) {                                   // drive in along the inbound lane
        s = ease(f / PH[0]); v.set(95 + (x - 7 - 95) * s, 0, IN_Z); T = [-1, 0]; forward = true;
      } else if (f < PH[0] + PH[1]) {                    // reverse into the dock
        s = ease((f - PH[0]) / PH[1]);
        const P = [[x - 7, IN_Z], [x + 3, IN_Z], [x, 14], [x, DOCK_Z]];
        bez(P[0], P[1], P[2], P[3], s, v); T = bezT(P[0], P[1], P[2], P[3], Math.min(0.999, Math.max(0.001, s))); forward = false;
      } else if (f < PH[0] + PH[1] + PH[2]) {            // loading
        v.set(x, 0, DOCK_Z); T = [0, -1]; forward = false;
      } else {                                           // pull out and leave
        s = Math.min(1, (f - PH[0] - PH[1] - PH[2]) / PH[3]);
        const P = [[x, DOCK_Z + 12.9], [x, 30], [x - 10, OUT_Z], [x - 26, OUT_Z]];
        if (s < 0.55) { bez(P[0], P[1], P[2], P[3], ease(s / 0.55), v); T = bezT(P[0], P[1], P[2], P[3], Math.max(0.001, ease(s / 0.55))); }
        else { v.set(x - 26 - (s - 0.55) / 0.45 * 110, 0, OUT_Z); T = [-1, 0]; }
        // the path above traces the cab; convert to the rear-of-trailer origin
        const len = Math.hypot(T[0], T[1]) || 1;
        v.x -= (T[0] / len) * 12.9; v.z -= (T[1] / len) * 12.9;
        forward = true;
      }
      const len = Math.hypot(T[0], T[1]) || 1, tx = T[0] / len, tz = T[1] / len;
      tr.rotation.y = forward ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz);
      tr.position.set(v.x, 0, v.z);
    }

    // ---- simulation state ------------------------------------------------------
    let run = null, sc = null, today = null, prevBacklog = 0, dayClock = 0, playing = true, speed = 1;
    let history = [], visits = [], doorsOpen = 8;
    function capacityDoors(cap) { return Math.max(1, Math.min(DOORS, Math.ceil((cap === Infinity ? 96 : cap) / ORDERS_PER_TRUCK))); }
    function advanceDay() {
      if (!run || run.done()) { playing = false; if (opts.onState) opts.onState({ playing: false }); return false; }
      prevBacklog = today ? today.backlog : 0;
      today = run.step();
      history.push(today);
      doorsOpen = capacityDoors(today.capacity);
      const nTrucks = Math.min(doorsOpen, Math.ceil(today.shipped / ORDERS_PER_TRUCK));
      // spread visits over the open doors, centre-out so the busy bays sit mid-building
      const order = Array.from({ length: doorsOpen }, (_, i) => i).sort((a, b) => Math.abs(a - (doorsOpen - 1) / 2) - Math.abs(b - (doorsOpen - 1) / 2));
      const first = Math.floor((DOORS - doorsOpen) / 2);
      visits = order.slice(0, nTrucks).map(function (k, j) { return { door: first + k, start: 0.03 + j * 0.034 }; });
      if (opts.onDay) opts.onDay(today, history);
      return true;
    }
    function setScenario(newSc, o) {
      sc = newSc; run = T.createRun(sc, CAL, (o && o.seed) || 1000); history = []; today = null;
      const start = (o && o.startDay) || 0;
      for (let d = 0; d < start; d++) { prevBacklog = today ? today.backlog : 0; today = run.step(); history.push(today); }
      dayClock = 1;   // trigger the next day immediately
      if (opts.onDay && today) opts.onDay(today, history);
    }
    function seek(day) {
      const keep = sc; if (!keep) return;
      setScenario(keep, { startDay: Math.max(0, Math.min(run.total - 1, day)) });
    }

    // ---- frame loop --------------------------------------------------------------
    let last = performance.now(), visible = true;
    function frame(now) {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (playing) {
        dayClock += dt * speed / SECONDS_PER_DAY;
        while (dayClock >= 1) { dayClock -= 1; if (!advanceDay()) { dayClock = 1; break; } }
      }
      const f = Math.min(1, dayClock);
      // backlog boxes: start of day = yesterday's backlog + today's arrivals, then shipped boxes leave with the trucks
      if (today) {
        const peakToday = prevBacklog + today.arrived;
        const arrive = Math.min(1, f / 0.12), ship = Math.max(0, Math.min(1, (f - 0.2) / 0.5));
        const orders = prevBacklog + (peakToday - prevBacklog) * arrive - (peakToday - today.backlog) * ship;
        showBoxes(orders / ORDERS_PER_BOX);
      }
      // trucks
      const busy = {};
      trucks.forEach(function (t) { t.visible = false; });
      visits.forEach(function (vis) {
        const tf = (f - vis.start);
        if (tf < 0 || tf > PH[0] + PH[1] + PH[2] + PH[3]) return;
        const tr = trucks[vis.door]; tr.visible = true; placeTruck(tr, vis.door, tf);
        if (tf > PH[0] && tf < PH[0] + PH[1] + PH[2] + 0.02) busy[vis.door] = true;
      });
      // doors
      const first = Math.floor((DOORS - doorsOpen) / 2);
      doors.forEach(function (d, i) {
        const open = i >= first && i < first + doorsOpen;
        d.open += ((open ? 1 : 0) - d.open) * Math.min(1, dt * 4);
        const k = 1 - 0.82 * d.open;                     // shutter rolls up, top edge fixed
        d.shutter.scale.y = k; d.shutter.position.y = doorH - (doorH * k) / 2;
        d.lamp.material = mat(busy[i] ? C.light : open ? 0xf1b434 : 0x555a5f);
      });
      if (opts.onFrame) opts.onFrame(f);
      if (visible) { placeCamera(); renderer.render(scene, camera); }
      requestAnimationFrame(frame);
    }

    // ---- size, visibility, camera drag -----------------------------------------
    function resize() {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false); renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
      camera.aspect = w / h;
      view.r = w < 560 ? 190 : w < 900 ? 150 : 128;
      camera.updateProjectionMatrix();
    }
    if (root.ResizeObserver) new ResizeObserver(resize).observe(el); else root.addEventListener("resize", resize);
    resize();
    if (root.IntersectionObserver) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(el);
    let drag = null;
    renderer.domElement.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY, az: view.az, polar: view.polar }; renderer.domElement.setPointerCapture(e.pointerId); });
    renderer.domElement.addEventListener("pointermove", function (e) {
      if (!drag) return;
      view.az = drag.az - (e.clientX - drag.x) * 0.005;
      view.polar = Math.max(0.45, Math.min(1.25, drag.polar - (e.clientY - drag.y) * 0.004));
    });
    renderer.domElement.addEventListener("pointerup", function () { drag = null; });
    renderer.domElement.addEventListener("wheel", function (e) { e.preventDefault(); view.r = Math.max(70, Math.min(260, view.r * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
    renderer.domElement.style.touchAction = "pan-y";
    renderer.domElement.style.cursor = "grab";

    // labels projected from 3D anchors
    function project(x, y, z) {
      v.set(x, y, z).project(camera);
      return { x: (v.x + 1) / 2 * el.clientWidth, y: (1 - v.y) / 2 * el.clientHeight };
    }

    requestAnimationFrame(frame);
    return {
      setScenario: setScenario, seek: seek, project: project,
      status: function () {
        return { day: today && today.day, dayFraction: Math.min(1, dayClock), backlog: today && today.backlog,
                 trucksOnScreen: trucks.filter(function (t) { return t.visible; }).length, doorsOpen: doorsOpen, visits: visits.length };
      },
      play: function () { playing = true; if (opts.onState) opts.onState({ playing: true }); },
      pause: function () { playing = false; if (opts.onState) opts.onState({ playing: false }); },
      toggle: function () { this[playing ? "pause" : "play"](); },
      isPlaying: function () { return playing; },
      setSpeed: function (s) { speed = s; },
      total: function () { return run ? run.total : 0; },
      constants: { ORDERS_PER_BOX: ORDERS_PER_BOX, ORDERS_PER_TRUCK: ORDERS_PER_TRUCK, DOORS: DOORS, SECONDS_PER_DAY: SECONDS_PER_DAY },
    };
  }

  root.DispatchYard = { mount: mount };
})(typeof self !== "undefined" ? self : this);
