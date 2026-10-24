/* 3D supply chain: animates one replication of the twin end to end (Three.js r128).
 *
 * Left to right, upstream to downstream, all driven by the simulation day by day:
 *   - supplier factory : boxes in its yard = units the DC has ordered but the supplier
 *                        has not shipped yet (1 box = 50 units); conveyor speed = output
 *   - inbound road     : trucks carrying supplier shipments, placed by how far through the
 *                        inbound lead time they are; they unload at the receiving doors
 *   - DC racks         : cartons = stock on hand (1 carton = 2 units); empty racks = stockout
 *   - DC staging lane  : orders waiting for dispatch (1 box = 4 orders)
 *   - dock doors       : dispatch capacity that day (8 orders per truck)
 *   - customer town    : outbound trucks drive to it; roofs show today's shipments on time (green) or late (red)
 * Usage: const yard = DispatchYard.mount(element, { twin, cal, onDay });
 *        yard.setScenario(scenario, { startDay });  yard.play(); yard.pause(); yard.setSpeed(x); yard.seek(day); yard.focus(name)
 */
(function (root) {
  "use strict";

  const ORDERS_PER_BOX = 4, ORDERS_PER_TRUCK = 8, DOORS = 12, SECONDS_PER_DAY = 4;
  const UNITS_PER_CARTON = 2, UNITS_PER_SUPPLIER_BOX = 50, UNITS_PER_INBOUND_TRUCK = 150;
  const C = {
    asphalt: 0x6c727a, line: 0xf4f5f2, road: 0x5c6168, wall: 0xf3f4f2, floor: 0xd8dcdb, trim: 0xc9cdcf,
    door: 0x2f3439, doorOpen: 0x14181b, rackUp: 0xe58a2e, rackBeam: 0x2d6cb4, carton: 0xc79a5c, cartonDark: 0xa9783f,
    pallet: 0xb58a55, trailer: 0xf7f8f8, stripe: 0x2a78d6, cab: 0xf1f2f2, glass: 0x26313a, tyre: 0x1d2024, light: 0x3ccf6e,
    factory: 0xe4e8ec, machine: 0x3d6fa8, conveyor: 0x464c52, grass: 0x6f8c66, house: 0xf2efe9, roof: 0x9aa1a8,
    onTime: 0x2fa35a, late: 0xd0473a, rawBox: 0xd9c49a,
  };
  const VIEWS = {
    chain: { x: -22, z: -8, r: 470, polar: 0.9, az: 0.14 },
    supplier: { x: -232, z: -14, r: 125, polar: 0.86, az: 0.5 },
    inbound: { x: -130, z: 8, r: 175, polar: 0.9, az: 0.35 },
    warehouse: { x: 0, z: -2, r: 128, polar: 0.84, az: 0.55 },
    customers: { x: 140, z: -12, r: 160, polar: 0.9, az: 0.45 },
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
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
    const target = new THREE.Vector3(VIEWS.chain.x, 0, VIEWS.chain.z);
    const view = { r: VIEWS.chain.r, polar: VIEWS.chain.polar, az: VIEWS.chain.az };
    let tween = null, viewName = "chain", rScale = 1;
    function focus(name) {
      const to = VIEWS[name]; if (!to) return; viewName = name;
      tween = { t: 0, from: { x: target.x, z: target.z, r: view.r, polar: view.polar, az: view.az },
                to: { x: to.x, z: to.z, r: to.r * rScale, polar: to.polar, az: to.az } };
    }
    function placeCamera() {
      camera.position.set(
        target.x + view.r * Math.sin(view.polar) * Math.sin(view.az),
        target.y + view.r * Math.cos(view.polar),
        target.z + view.r * Math.sin(view.polar) * Math.cos(view.az));
      camera.lookAt(target);
    }

    // ---- light ---------------------------------------------------------------
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7d848a, 0.62));
    const sun = new THREE.DirectionalLight(0xffffff, 0.72);
    sun.position.set(-50, 90, 45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -300, right: 240, top: 120, bottom: -120, near: 10, far: 420 });
    sun.position.set(-60, 160, 80);
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
    function plane(w, d, color, x, z, y) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color));
      m.rotation.x = -Math.PI / 2; m.position.set(x, y || 0, z); m.receiveShadow = true; scene.add(m); return m;
    }
    plane(760, 360, C.grass, -30, -10, -0.05);                         // countryside
    plane(250, 130, C.asphalt, 0, -5, 0);                              // DC site
    plane(90, 70, C.asphalt, -232, -12, 0);                            // supplier site
    plane(380, 18, C.road, -10, 34, 0.02);                             // main road to customers
    for (let x = -60; x < 180; x += 8) box(4, 0.02, 0.35, C.line, x, 0.03, 34, null, false);
    plane(150, 10, C.road, -128, 22, 0.025);                           // inbound road
    for (let x = -200; x < -58; x += 8) box(4, 0.02, 0.3, C.line, x, 0.035, 22, null, false);
    plane(10, 34, C.road, -56, 6, 0.025);                              // connector to receiving
    for (let i = 0; i < DOORS; i++) {     // bay lines in front of the docks
      const x = doorX(i) - 3.3;
      box(0.3, 0.02, 16, C.line, x, 0.03, 4.5, null, false);
    }
    box(0.3, 0.02, 16, C.line, doorX(DOORS - 1) + 3.3, 0.03, 4.5, null, false);

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
          for (let k = 0; k < 2; k++) if (x + 2.8 <= 40) cartons.push([x + 0.75 + k * 1.3, h + 0.53, z]);
        });
        if (x + 2.8 <= 40) for (let k = 0; k < 2; k++) cartons.push([x + 0.75 + k * 1.3, 0.53, z]);
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
    // stock on hand: cartons fill the rack slots in a fixed shuffled order, so racks empty visibly
    for (let i = cartons.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = cartons[i]; cartons[i] = cartons[j]; cartons[j] = t; }
    const stockMesh = instanced(cartonGeo, C.carton, cartons);
    const MAX_CARTONS = cartons.length;
    function showStock(nCartons) {
      const n = Math.max(0, Math.min(MAX_CARTONS, Math.round(nCartons)));
      const o = new THREE.Object3D();
      cartons.forEach(function (p, i) {
        const k = i < n ? 1 : 1e-4;
        o.position.set(p[0], p[1], p[2]); o.scale.set(k, k, k); o.updateMatrix(); stockMesh.setMatrixAt(i, o.matrix);
      });
      stockMesh.instanceMatrix.needsUpdate = true;
    }
    // receiving doors on the DC's left wall (inbound from the supplier)
    const RECV_Z = [-13, -21, -29];
    const recvLamps = RECV_Z.map(function (z) {
      box(0.25, 4.3, 3.6, mat(C.door), W.x0 - 0.45, 0, z, null, false);
      box(1.4, 1.1, 4.2, mat(0x4b5056), W.x0 - 1.0, 0, z);
      return box(0.2, 0.5, 0.5, mat(0x555a5f), W.x0 - 0.45, 4.6, z + 2.4, null, false);
    });

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
    // ---- supplier factory (upstream) ---------------------------------------------
    const F = { x0: -262, x1: -202, z0: -36, z1: -4, h: 5.2 };
    const ffloor = new THREE.Mesh(new THREE.PlaneGeometry(F.x1 - F.x0, F.z1 - F.z0), mat(0xd3d7da));
    ffloor.rotation.x = -Math.PI / 2; ffloor.position.set((F.x0 + F.x1) / 2, 0.06, (F.z0 + F.z1) / 2); ffloor.receiveShadow = true; scene.add(ffloor);
    box(F.x1 - F.x0, F.h, 0.7, C.factory, (F.x0 + F.x1) / 2, 0, F.z0);
    box(0.7, F.h, F.z1 - F.z0, C.factory, F.x0, 0, (F.z0 + F.z1) / 2);
    box(0.7, F.h, F.z1 - F.z0, C.factory, F.x1, 0, (F.z0 + F.z1) / 2);
    box(F.x1 - F.x0 - 24, F.h, 0.7, C.factory, F.x0 + (F.x1 - F.x0 - 24) / 2, 0, F.z1);      // front wall, gate on the right
    box(24, F.h - 4.4, 0.7, C.factory, F.x1 - 12, 4.4, F.z1);
    for (let i = 0; i < 6; i++) box(9.6, 1.1, 0.4, mat(0xb9c2cb), F.x0 + 5 + i * 10, F.h, -20, null, false);  // roof trusses
    [[-272, -30], [-272, -22]].forEach(function (p) {                                    // silos
      const silo = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 14, 20), mat(0xeef0f2));
      silo.position.set(p[0], 7, p[1]); silo.castShadow = true; scene.add(silo);
    });
    const LINES_Z = [-28, -18];
    LINES_Z.forEach(function (z) {
      box(46, 0.9, 1.8, C.conveyor, -236, 0, z);
      for (let k = 0; k < 4; k++) box(3.2, 3.2, 3.4, C.machine, -254 + k * 12, 0, z - 2.8);
    });
    const CONV_N = 16;
    const convMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.9, 1.1), mat(C.carton), CONV_N * LINES_Z.length);
    convMesh.castShadow = true; scene.add(convMesh);
    let convPhase = 0;
    function showConveyor(speed, dt) {
      convPhase = (convPhase + dt * speed * 6) % 2.8;
      const o = new THREE.Object3D();
      LINES_Z.forEach(function (z, li) {
        for (let k = 0; k < CONV_N; k++) {
          o.position.set(-258 + k * 2.8 + convPhase, 1.35, z); o.scale.setScalar(speed > 0.02 ? 1 : 1e-4);
          o.updateMatrix(); convMesh.setMatrixAt(li * CONV_N + k, o.matrix);
        }
      });
      convMesh.instanceMatrix.needsUpdate = true;
    }
    // supplier backlog: units ordered by the DC and not shipped yet, stacked in the factory yard
    const SB = { x0: -250, cols: 20, rows: 3, layers: 8, dx: 1.6, dz: 1.5, z0: -11.5 };
    const sbSlots = [];
    for (let l = 0; l < SB.layers; l++) for (let row = 0; row < SB.rows; row++) for (let c = 0; c < SB.cols; c++)
      sbSlots.push([SB.x0 + c * SB.dx, 0.08 + l * 1.02 + 0.5, SB.z0 - row * SB.dz]);
    const sbMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.35, 1.0, 1.25), mat(C.rawBox), sbSlots.length);
    sbMesh.castShadow = true; scene.add(sbMesh);
    function showSupplierBacklog(nBoxes) {
      const n = Math.max(0, Math.min(sbSlots.length, Math.round(nBoxes))), o = new THREE.Object3D();
      sbSlots.forEach(function (p, i) { const k = i < n ? 1 : 1e-4; o.position.set(p[0], p[1], p[2]); o.scale.setScalar(k); o.updateMatrix(); sbMesh.setMatrixAt(i, o.matrix); });
      sbMesh.instanceMatrix.needsUpdate = true;
    }

    // ---- customer town (downstream) ----------------------------------------------
    const HOUSES = [];
    for (let row = 0; row < 5; row++) for (let c = 0; c < 9; c++) HOUSES.push([84 + c * 15 + (row % 2) * 5, -44 + row * 13]);
    plane(160, 76, 0x88a07f, 152, -18, 0.01);
    for (let row = 0; row < 5; row++) plane(150, 3.5, 0xc9ccc8, 152, -44 + row * 13 + 6.5, 0.03);   // streets
    const houseMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(7, 4, 6.5), mat(C.house), HOUSES.length);
    const roofGeo = new THREE.ConeGeometry(5.4, 3.2, 4); roofGeo.rotateY(Math.PI / 4);
    const roofMesh = new THREE.InstancedMesh(roofGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), HOUSES.length);
    roofMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(HOUSES.length * 3), 3);
    (function () {
      const o = new THREE.Object3D();
      HOUSES.forEach(function (p, i) {
        o.position.set(p[0], 2, p[1]); o.updateMatrix(); houseMesh.setMatrixAt(i, o.matrix);
        o.position.set(p[0], 5.6, p[1]); o.updateMatrix(); roofMesh.setMatrixAt(i, o.matrix);
      });
      houseMesh.castShadow = roofMesh.castShadow = true; houseMesh.receiveShadow = true;
      scene.add(houseMesh); scene.add(roofMesh);
    })();
    const cRoof = new THREE.Color(C.roof), cOn = new THREE.Color(C.onTime), cLate = new THREE.Color(C.late);
    function paintRoofs(d) {
      const n = HOUSES.length, lit = d ? Math.min(n, Math.round(d.shipped / 2)) : 0;
      const green = d && d.shipped ? Math.round(lit * d.onTime / d.shipped) : 0;
      const g = rng(1 + (d ? d.day : 0) * 7919), order = HOUSES.map(function (_, i) { return i; });
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
      order.forEach(function (h, k) { (k < green ? cOn : k < lit ? cLate : cRoof).toArray(roofMesh.instanceColor.array, h * 3); });
      roofMesh.instanceColor.needsUpdate = true;
    }
    paintRoofs(null);

    // trucks: one per door, reused every day
    const trucks = [];
    for (let i = 0; i < DOORS; i++) { const tr = makeTruck(true); tr.visible = false; trucks.push(tr); }
    const inboundTrucks = [];
    for (let i = 0; i < 40; i++) { const tr = makeTruck(true); tr.visible = false; inboundTrucks.push(tr); }

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
        s = ease(f / PH[0]); v.set(175 + (x - 7 - 175) * s, 0, IN_Z); T = [-1, 0]; forward = true;
      } else if (f < PH[0] + PH[1]) {                    // reverse into the dock
        s = ease((f - PH[0]) / PH[1]);
        const P = [[x - 7, IN_Z], [x + 3, IN_Z], [x, 14], [x, DOCK_Z]];
        bez(P[0], P[1], P[2], P[3], s, v); T = bezT(P[0], P[1], P[2], P[3], Math.min(0.999, Math.max(0.001, s))); forward = false;
      } else if (f < PH[0] + PH[1] + PH[2]) {            // loading
        v.set(x, 0, DOCK_Z); T = [0, -1]; forward = false;
      } else {                                           // pull out and leave
        s = Math.min(1, (f - PH[0] - PH[1] - PH[2]) / PH[3]);
        const P = [[x, DOCK_Z + 12.9], [x, 30], [x + 10, OUT_Z], [x + 26, OUT_Z]];
        if (s < 0.55) { bez(P[0], P[1], P[2], P[3], ease(s / 0.55), v); T = bezT(P[0], P[1], P[2], P[3], Math.max(0.001, ease(s / 0.55))); }
        else { v.set(x + 26 + (s - 0.55) / 0.45 * 140, 0, OUT_Z); T = [1, 0]; }
        // the path above traces the cab; convert to the rear-of-trailer origin
        const len = Math.hypot(T[0], T[1]) || 1;
        v.x -= (T[0] / len) * 12.9; v.z -= (T[1] / len) * 12.9;
        forward = true;
      }
      const len = Math.hypot(T[0], T[1]) || 1, tx = T[0] / len, tz = T[1] / len;
      tr.rotation.y = forward ? Math.atan2(tx, tz) : Math.atan2(-tx, -tz);
      tr.position.set(v.x, 0, v.z);
    }

    // inbound road: factory gate -> along z=22 -> up the connector -> receiving door
    const IN_PATH = [[-206, 22], [-56, 22], [-56, -4]];
    const IN_LEN = [150, 26], IN_TOTAL = 176, TRUCK_LEN = 16;
    function placeInbound(tr, dist) {             // dist = metres travelled by the cab
      let x, z, T;
      if (dist <= IN_LEN[0]) { x = IN_PATH[0][0] + dist; z = 22; T = [1, 0]; }
      else { const d2 = Math.min(IN_LEN[1], dist - IN_LEN[0]); x = -56; z = 22 - d2; T = [0, -1]; }
      tr.rotation.y = Math.atan2(T[0], T[1]);
      tr.position.set(x - T[0] * 15.5, 0, z - T[1] * 15.5);
    }
    function dockInbound(tr, k) {                 // rear against receiving door k, cab pointing west
      tr.rotation.y = -Math.PI / 2;
      tr.position.set(W.x0 - 1.8, 0, RECV_Z[k]);
    }

    // ---- simulation state ------------------------------------------------------
    let run = null, sc = null, today = null, prevBacklog = 0, dayClock = 0, playing = true, speed = 1;
    let history = [], visits = [], doorsOpen = 8, inboundNow = [], prevStock = null;
    function capacityDoors(cap) { return Math.max(1, Math.min(DOORS, Math.ceil((cap === Infinity ? 96 : cap) / ORDERS_PER_TRUCK))); }
    function advanceDay() {
      if (!run || run.done()) { playing = false; if (opts.onState) opts.onState({ playing: false }); return false; }
      prevBacklog = today ? today.backlog : 0;
      prevStock = today && today.chain ? today.chain.onHand : null;
      today = run.step();
      history.push(today);
      inboundNow = run.inbound();
      paintRoofs(today);
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
      for (let d = 0; d < start; d++) { prevBacklog = today ? today.backlog : 0; prevStock = today && today.chain ? today.chain.onHand : null; today = run.step(); history.push(today); }
      inboundNow = run.inbound(); paintRoofs(today);
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
      if (tween) {
        tween.t = Math.min(1, tween.t + dt / 1.1); const e = ease(tween.t), a = tween.from, b = tween.to;
        target.x = a.x + (b.x - a.x) * e; target.z = a.z + (b.z - a.z) * e;
        view.r = a.r + (b.r - a.r) * e; view.polar = a.polar + (b.polar - a.polar) * e; view.az = a.az + (b.az - a.az) * e;
        if (tween.t >= 1) tween = null;
      }
      const ch = today && today.chain;
      // upstream: supplier backlog, conveyor speed, stock in racks
      if (ch) {
        showSupplierBacklog(ch.supplierBacklog / UNITS_PER_SUPPLIER_BOX);
        showConveyor(ch.supplierCap === Infinity ? 1 : ch.supplierShipped / ch.supplierCap, dt * (playing ? speed : 0));
        // stock: start of day + receipts, then shipped units leave with the trucks
        const start = prevStock == null ? ch.onHand : prevStock, afterRecv = start + ch.received;
        const ship = Math.max(0, Math.min(1, (f - 0.2) / 0.5));
        showStock((Number.isFinite(afterRecv) ? afterRecv - (afterRecv - ch.onHand) * ship : 1e9) / UNITS_PER_CARTON);
      } else {
        showSupplierBacklog(0); showConveyor(0.6, dt * (playing ? speed : 0)); showStock(MAX_CARTONS * 0.7);
      }
      // inbound trucks on the road and at the receiving doors
      inboundTrucks.forEach(function (t) { t.visible = false; });
      let ti = 0;
      if (ch && today) {
        const tau = today.day + f, Lr = ch.lead;
        inboundNow.forEach(function (sh) {
          const n = Math.min(4, Math.ceil(sh.units / UNITS_PER_INBOUND_TRUCK));
          const prog = (tau - (sh.shipped + 0.5)) / Math.max(0.5, Lr - 0.5);
          if (prog < 0) return;
          for (let k = 0; k < n && ti < inboundTrucks.length; k++) {
            const dist = Math.min(1, prog) * IN_TOTAL - k * TRUCK_LEN * 1.15;
            if (dist < 0) continue;
            const tr = inboundTrucks[ti++]; tr.visible = true; placeInbound(tr, dist);
          }
        });
        const nRecv = ch.received > 0 && f < 0.55 ? Math.min(RECV_Z.length, Math.ceil(ch.received / UNITS_PER_INBOUND_TRUCK)) : 0;
        for (let k = 0; k < nRecv && ti < inboundTrucks.length; k++) { const tr = inboundTrucks[ti++]; tr.visible = true; dockInbound(tr, k); }
        recvLamps.forEach(function (l, k) { l.material = mat(k < nRecv ? C.light : 0x555a5f); });
      }
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
      const nextScale = w < 560 ? 1.55 : w < 900 ? 1.2 : 1;
      if (nextScale !== rScale) { view.r = view.r / rScale * nextScale; rScale = nextScale; }
      camera.updateProjectionMatrix();
    }
    if (root.ResizeObserver) new ResizeObserver(resize).observe(el); else root.addEventListener("resize", resize);
    resize();
    if (root.IntersectionObserver) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(el);
    let drag = null;
    renderer.domElement.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY, az: view.az, polar: view.polar }; renderer.domElement.setPointerCapture(e.pointerId); });
    renderer.domElement.addEventListener("pointermove", function (e) {
      if (!drag) return;
      tween = null;
      view.az = drag.az - (e.clientX - drag.x) * 0.005;
      view.polar = Math.max(0.45, Math.min(1.25, drag.polar - (e.clientY - drag.y) * 0.004));
    });
    renderer.domElement.addEventListener("pointerup", function () { drag = null; });
    renderer.domElement.addEventListener("wheel", function (e) { e.preventDefault(); tween = null; view.r = Math.max(60, Math.min(800, view.r * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
    renderer.domElement.style.touchAction = "pan-y";
    renderer.domElement.style.cursor = "grab";

    // labels projected from 3D anchors
    function project(x, y, z) {
      v.set(x, y, z).project(camera);
      return { x: (v.x + 1) / 2 * el.clientWidth, y: (1 - v.y) / 2 * el.clientHeight };
    }

    requestAnimationFrame(frame);
    return {
      setScenario: setScenario, seek: seek, project: project, focus: focus, view: function () { return viewName; },
      status: function () {
        return { day: today && today.day, dayFraction: Math.min(1, dayClock), backlog: today && today.backlog,
                 trucksOnScreen: trucks.filter(function (t) { return t.visible; }).length, doorsOpen: doorsOpen, visits: visits.length,
                 inboundOnScreen: inboundTrucks.filter(function (t) { return t.visible; }).length,
                 stock: today && today.chain ? today.chain.onHand : null, supplierBacklog: today && today.chain ? today.chain.supplierBacklog : null };
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
