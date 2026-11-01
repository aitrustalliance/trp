/**
 * Nautilus 3D world, drawn with Three.js.
 *
 * Every model is built in code. The Nautilus follows Verne's description in
 * Twenty Thousand Leagues Under the Seas: a long iron spindle with conical
 * ends, a steel spur at the bow, a low platform with a pilot house and an
 * electric lantern, oval salon windows and a four-bladed screw. The villain's
 * ship follows Verne's Albatross from Robur the Conqueror: a long hull whose
 * deck carries rows of masts, each topped by a horizontal propeller.
 *
 * The game core works in a flat 1280 by 720 world. This file maps that plane
 * into 3D at z = 0, so gameplay and scoring are the same in 2D and 3D.
 */
(async () => {
  let T;
  try { T = await import("./vendor/three-0.186.1.js"); } catch (err) { console.warn("Three.js failed to load", err); window.NautilusWorld3DFailed = true; return; }
  window.NautilusWorld3D = () => makeWorld(T);
})();

function makeWorld(T) {
  const C = window.TRPNautilusCore;
  const ART = window.NautilusArt;
  const U = 40;                              // world pixels per unit
  const X = (x) => (x - C.SUB_X) / U;
  const Y = (y) => -(y - C.WATER) / U;
  const BOTTOM = Y(C.H) - 0.2;
  const LOOK = new T.Vector3(7.2, -4.2, 0);

  let renderer, scene, camera, composer, bloom, clock = 0, cw = 1, ch = 1;
  let salon = null;
  let sub, airship, water, seabed, lantern, searchBeam, searchLight, envTex;
  let ruins = [], kelp = [], shafts = [];
  let hemi, moon, seaFx = null, seaKey = null, zoom = 1;
  let intro = 0, caustic = null, vents = null, swellAmp = 1, lanternBase = 220;
  const meshes = new Map();                  // payload, gear and harpoon meshes by id
  const sparks = makePool(900, true);
  const bubbles = makePool(700, false);
  let snow;
  const rings = [];
  const flashes = [];
  let glowMap = null;
  let fogBase, fogCaptured, currentSkin = null, currentPennant = null;

  function init(canvas) {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    if (!renderer.getContext()) throw new Error("WebGL unavailable");
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = T.SRGBColorSpace;
    scene = new T.Scene();
    fogBase = new T.Color(0x0b2746);
    fogCaptured = new T.Color(0x1d1640);
    scene.fog = new T.FogExp2(fogBase.clone(), 0.03);
    camera = new T.PerspectiveCamera(40, 16 / 9, 0.1, 400);

    envTex = makeEnvironment();
    scene.environment = envTex;

    hemi = new T.HemisphereLight(0x6f8fc4, 0x05080f, 0.85);
    scene.add(hemi);
    moon = new T.DirectionalLight(0xbfd2f2, 1.6);
    moon.position.set(6, 20, 14);
    scene.add(moon);

    scene.add(makeBackdrop());
    water = makeWater(); scene.add(water);
    seabed = makeSeabed(); scene.add(seabed);
    shafts = makeShafts(); shafts.forEach((s) => scene.add(s));
    ruins = makeRuins(); ruins.forEach((r) => scene.add(r));
    kelp = makeKelp(); kelp.forEach((k) => scene.add(k));
    snow = makeSnow(); scene.add(snow);
    vents = makeVents(); scene.add(vents); vents.visible = false;
    scene.add(sparks.points, bubbles.points);

    sub = makeNautilus(); scene.add(sub.group);
    airship = makeAlbatross(); scene.add(airship.group);

    composer = new T.EffectComposer(renderer);
    composer.addPass(new T.RenderPass(scene, camera));
    bloom = new T.UnrealBloomPass(new T.Vector2(512, 512), 0.75, 0.45, 0.78);
    composer.addPass(bloom);
    composer.addPass(new T.OutputPass());
  }

  function resize(w, h, dpr) {
    cw = w; ch = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    // Keep the whole play area in view at any shape of screen.
    const halfV = Math.tan(T.MathUtils.degToRad(camera.fov / 2));
    const needH = 20.5, needW = 34;
    const dist = Math.max(needH / (2 * halfV), needW / (2 * halfV * camera.aspect));
    camera.userData.dist = dist;
    camera.updateProjectionMatrix();
  }

  function project(x, y) {
    const v = new T.Vector3(X(x), Y(y), 0).project(camera);
    return { x: (v.x + 1) / 2 * cw, y: (1 - v.y) / 2 * ch };
  }

  const ray = new T.Raycaster();
  const plane = new T.Plane(new T.Vector3(0, 0, 1), 0);
  function unproject(sx, sy) {
    ray.setFromCamera(new T.Vector2(sx / cw * 2 - 1, -(sy / ch) * 2 + 1), camera);
    const hit = new T.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return { x: C.SUB_X, y: C.WATER };
    return { x: hit.x * U + C.SUB_X, y: -hit.y * U + C.WATER };
  }

  // ---------------------------------------------------------------- Models

  function metal(color, rough, metalness) {
    return new T.MeshStandardMaterial({ color, roughness: rough == null ? 0.35 : rough, metalness: metalness == null ? 0.85 : metalness, envMapIntensity: 1.1 });
  }
  function glow(color, intensity) {
    return new T.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity || 2.5 });
  }

  // Verne: "a very long cylinder with conical ends ... the shape of a cigar".
  function spindleRadius(t) { return 0.82 * Math.pow(Math.sin(Math.PI * t), 0.72); }

  function makeNautilus() {
    const group = new T.Group();
    const L = 6.2;
    const pts = [];
    for (let i = 0; i <= 48; i++) { const t = i / 48; pts.push(new T.Vector2(Math.max(0.001, spindleRadius(t)), t * L - L / 2)); }
    const hullGeo = new T.LatheGeometry(pts, 64);
    hullGeo.rotateZ(-Math.PI / 2);
    const hullMat = metal(0xc49a55, 0.38, 0.85);
    hullMat.bumpMap = platingTexture(); hullMat.bumpScale = 0.9;
    const hull = new T.Mesh(hullGeo, hullMat);
    group.add(hull);

    const bandMat = metal(0x3d2b14, 0.45, 0.9);
    const rivetMat = metal(0xf0d9a0, 0.25, 1);
    const rivetGeo = new T.SphereGeometry(0.035, 6, 6);
    const bandsAt = [0.18, 0.32, 0.46, 0.6, 0.74, 0.86];
    const rivets = new T.InstancedMesh(rivetGeo, rivetMat, bandsAt.length * 28);
    const m = new T.Matrix4();
    let n = 0;
    for (const t of bandsAt) {
      const r = spindleRadius(t);
      const band = new T.Mesh(new T.TorusGeometry(r + 0.012, 0.03, 8, 64), bandMat);
      band.rotation.y = Math.PI / 2;
      band.position.x = t * L - L / 2;
      group.add(band);
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        m.makeTranslation(t * L - L / 2 + 0.07, Math.cos(a) * (r + 0.03), Math.sin(a) * (r + 0.03));
        rivets.setMatrixAt(n++, m);
      }
    }
    rivets.instanceMatrix.needsUpdate = true;
    group.add(rivets);

    // Steel spur at the bow.
    const spur = new T.Mesh(new T.ConeGeometry(0.12, 1.1, 16), metal(0x9aa6bd, 0.25, 1));
    spur.rotation.z = -Math.PI / 2;
    spur.position.x = L / 2 + 0.45;
    group.add(spur);

    // Platform, pilot house and lantern.
    const deck = new T.Mesh(new T.BoxGeometry(2.6, 0.06, 0.62), metal(0x5e4421, 0.6, 0.6));
    deck.position.set(0.1, 0.8, 0);
    group.add(deck);
    const railMat = metal(0xc49a55, 0.3, 1);
    for (const z of [-0.3, 0.3]) {
      const rail = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 2.5, 6), railMat);
      rail.rotation.z = Math.PI / 2; rail.position.set(0.1, 0.98, z); group.add(rail);
      for (let i = 0; i < 9; i++) { const post = new T.Mesh(new T.CylinderGeometry(0.01, 0.01, 0.18, 6), railMat); post.position.set(-1.1 + i * 0.3, 0.89, z); group.add(post); }
    }
    const house = new T.Mesh(new T.CapsuleGeometry(0.22, 0.45, 6, 16), metal(0x8a6a3a, 0.35, 0.85));
    house.rotation.z = Math.PI / 2; house.position.set(1.0, 1.02, 0); house.scale.set(1, 1, 0.85);
    group.add(house);
    const houseGlass = new T.Mesh(new T.SphereGeometry(0.07, 12, 12), glow(0xbfe0ff, 3));
    for (const z of [-0.17, 0.17]) { const g = houseGlass.clone(); g.position.set(1.15, 1.05, z); group.add(g); }
    const lamp = new T.Mesh(new T.SphereGeometry(0.11, 16, 16), glow(0xfff1c9, 6));
    lamp.position.set(-0.75, 1.0, 0);
    group.add(lamp);
    const lampCage = new T.Mesh(new T.TorusGeometry(0.13, 0.015, 6, 16), railMat);
    lampCage.position.copy(lamp.position); group.add(lampCage);

    lantern = new T.SpotLight(0xffe2b0, 220, 40, 0.42, 0.55, 1.6);
    lantern.position.set(3.4, 0.2, 0);
    lantern.target.position.set(14, -0.6, 0);
    group.add(lantern, lantern.target);
    const beamTex = gradientTexture([[0, "rgba(255,255,255,0.9)"], [0.25, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]]);
    const beam = new T.Mesh(new T.ConeGeometry(2.2, 9, 32, 1, true), new T.MeshBasicMaterial({ color: 0xffe2b0, map: beamTex, transparent: true, opacity: 0.12, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false }));
    beam.rotation.z = Math.PI / 2; beam.position.set(L / 2 + 4.7, -0.1, 0);
    group.add(beam);

    // Two great oval salon windows on each side.
    const winMat = glow(0xffd99a, 2.2);
    const frameMat = metal(0x3d2b14, 0.5, 0.9);
    for (const x of [-0.65, 0.35]) for (const z of [-1, 1]) {
      const r = spindleRadius((x + L / 2) / L);
      const win = new T.Mesh(new T.CircleGeometry(0.2, 32), winMat);
      win.scale.set(1.55, 1, 1); win.position.set(x, -0.05, z * (r + 0.005));
      if (z < 0) win.rotation.y = Math.PI;
      const fr = new T.Mesh(new T.TorusGeometry(0.21, 0.025, 8, 32), frameMat);
      fr.scale.set(1.55, 1, 1); fr.position.copy(win.position);
      group.add(win, fr);
    }
    // Small portholes.
    for (let i = 0; i < 5; i++) for (const z of [-1, 1]) {
      const x = -2.2 + i * 0.32 + (i > 1 ? 2.4 : 0);
      const r = spindleRadius((x + L / 2) / L);
      const p = new T.Mesh(new T.CircleGeometry(0.06, 16), glow(0xffd99a, 1.6));
      p.position.set(x, 0.18, z * (r + 0.004)); if (z < 0) p.rotation.y = Math.PI;
      group.add(p);
    }

    // Fins and rudder.
    const finMat = metal(0x5e4421, 0.45, 0.8);
    const finShape = new T.Shape(); finShape.moveTo(0, 0); finShape.lineTo(-0.7, 0.55); finShape.lineTo(-0.85, 0.55); finShape.lineTo(-0.5, 0); finShape.lineTo(0, 0);
    const finGeo = new T.ExtrudeGeometry(finShape, { depth: 0.03, bevelEnabled: false });
    for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const f = new T.Mesh(finGeo, finMat);
      f.position.set(-L / 2 + 0.6, 0, 0); f.rotation.x = rot;
      group.add(f);
    }

    // Four-bladed screw.
    const screw = new T.Group();
    screw.position.set(-L / 2 - 0.25, 0, 0);
    const bladeMat = metal(0xf0d9a0, 0.25, 1);
    for (let i = 0; i < 4; i++) {
      const b = new T.Mesh(new T.BoxGeometry(0.04, 0.55, 0.16), bladeMat);
      b.position.y = 0.3; const holder = new T.Group(); holder.rotation.x = (i * Math.PI) / 2; b.rotation.y = 0.5; holder.add(b); screw.add(holder);
    }
    screw.add(new T.Mesh(new T.SphereGeometry(0.1, 12, 12), bladeMat));
    group.add(screw);

    // Periscope, harpoon gun and pennant.
    const scope = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, 0.65, 8), railMat);
    scope.position.set(0.85, 1.4, 0); group.add(scope);
    const gun = new T.Mesh(new T.CylinderGeometry(0.05, 0.07, 0.5, 10), metal(0x3d2b14, 0.4, 0.9));
    gun.rotation.z = -Math.PI / 3; gun.position.set(1.55, 1.05, 0); group.add(gun);
    const penGeo = new T.PlaneGeometry(0.7, 0.22, 10, 1);
    const pennant = new T.Mesh(penGeo, new T.MeshStandardMaterial({ color: 0xe6d3a1, side: T.DoubleSide, roughness: 0.8 }));
    pennant.position.set(0.5, 1.62, 0); pennant.visible = false; group.add(pennant);

    return { group, hullMat, bandMat, screw, pennant, penBase: Float32Array.from(penGeo.attributes.position.array) };
  }

  function applySkin(id) {
    const sk = ART.SKINS[id] || ART.SKINS.brass;
    sub.hullMat.color.set(sk.mid);
    sub.bandMat.color.set(sk.band);
    currentSkin = id;
  }
  function applyPennant(id) {
    const p = ART.PENNANTS[id];
    sub.pennant.visible = !!(p && p.a);
    if (p && p.a) sub.pennant.material.color.set(p.a);
    currentPennant = id;
  }

  // Verne's Albatross: a long hull, a deck of masts with horizontal screws.
  function makeAlbatross() {
    const group = new T.Group();
    const L = 10;
    const pts = [];
    for (let i = 0; i <= 40; i++) { const t = i / 40; pts.push(new T.Vector2(Math.max(0.001, 0.85 * Math.pow(Math.sin(Math.PI * t), 0.5) * (t < 0.5 ? 1 : 1 - (t - 0.5) * 0.4)), t * L - L / 2)); }
    const hullGeo = new T.LatheGeometry(pts, 48); hullGeo.rotateZ(Math.PI / 2);
    const hull = new T.Mesh(hullGeo, metal(0x2a2f3d, 0.5, 0.75));
    hull.scale.set(1, 0.7, 1);
    group.add(hull);
    const ribMat = metal(0x141824, 0.6, 0.6);
    for (let i = 1; i < 10; i++) {
      const t = i / 10; const r = 0.85 * Math.pow(Math.sin(Math.PI * t), 0.5) * (t < 0.5 ? 1 : 1 - (t - 0.5) * 0.4);
      const rib = new T.Mesh(new T.TorusGeometry(r + 0.01, 0.025, 6, 40), ribMat);
      rib.rotation.y = Math.PI / 2; rib.scale.set(1, 0.7, 1); rib.position.x = -(t * L - L / 2); group.add(rib);
    }
    const deck = new T.Mesh(new T.BoxGeometry(L * 0.8, 0.06, 0.9), metal(0x1b1f2b, 0.7, 0.5));
    deck.position.y = 0.58; group.add(deck);
    const rotors = [];
    const mastMat = metal(0x1a1e2a, 0.5, 0.8);
    const discMat = new T.MeshBasicMaterial({ color: 0xaab4c8, transparent: true, opacity: 0.16, depthWrite: false, side: T.DoubleSide });
    for (let i = 0; i < 12; i++) for (const z of [-0.28, 0.28]) {
      const x = -L * 0.36 + i * (L * 0.72 / 11);
      const h = 1.1 + (i % 3) * 0.15;
      const mast = new T.Mesh(new T.CylinderGeometry(0.025, 0.035, h, 6), mastMat);
      mast.position.set(x, 0.58 + h / 2, z); group.add(mast);
      const rotor = new T.Group(); rotor.position.set(x, 0.6 + h, z);
      for (let k = 0; k < 2; k++) { const blade = new T.Mesh(new T.BoxGeometry(0.75, 0.012, 0.06), mastMat); blade.rotation.y = (k * Math.PI) / 2; rotor.add(blade); }
      const disc = new T.Mesh(new T.CircleGeometry(0.38, 24), discMat); disc.rotation.x = -Math.PI / 2; rotor.add(disc);
      group.add(rotor); rotors.push(rotor);
    }
    const cabin = new T.Mesh(new T.BoxGeometry(2.4, 0.42, 0.7), metal(0x151924, 0.55, 0.6));
    cabin.position.set(0.4, -0.7, 0); group.add(cabin);
    const winMat = glow(0xcdd6ff, 3.2);
    for (let i = 0; i < 8; i++) { const w = new T.Mesh(new T.PlaneGeometry(0.16, 0.1), winMat); w.position.set(-0.6 + i * 0.28, -0.7, 0.355); group.add(w); }
    // The eye on the hull.
    const eyeRing = new T.Mesh(new T.TorusGeometry(0.32, 0.035, 8, 32), metal(0xb9c3e0, 0.3, 1));
    eyeRing.scale.set(1.5, 1, 1); eyeRing.position.set(-1.2, 0.05, 0.82); group.add(eyeRing);
    const pupil = new T.Mesh(new T.SphereGeometry(0.09, 16, 16), glow(0xdfe6ff, 5)); pupil.position.set(-1.2, 0.05, 0.86); group.add(pupil);
    // Fore and aft screws.
    const screws = [];
    for (const x of [-L / 2 - 0.15, L / 2 + 0.1]) {
      const s = new T.Group(); s.position.set(x, 0, 0);
      for (let k = 0; k < 3; k++) { const b = new T.Mesh(new T.BoxGeometry(0.03, 0.5, 0.1), mastMat); b.position.y = 0.25; const h = new T.Group(); h.rotation.x = (k * Math.PI * 2) / 3; h.add(b); s.add(h); }
      group.add(s); screws.push(s);
    }
    // Searchlight.
    searchLight = new T.SpotLight(0xd6e0ff, 260, 60, 0.22, 0.6, 1.4);
    searchLight.position.set(0.4, -0.9, 0);
    searchLight.target.position.set(0.4, -20, 0);
    group.add(searchLight, searchLight.target);
    const searchTex = gradientTexture([[0, "rgba(255,255,255,0.9)"], [0.4, "rgba(255,255,255,0.3)"], [1, "rgba(255,255,255,0)"]]);
    searchBeam = new T.Mesh(new T.ConeGeometry(2.6, 18, 32, 1, true), new T.MeshBasicMaterial({ color: 0xd6e0ff, map: searchTex, transparent: true, opacity: 0.1, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false }));
    searchBeam.geometry.translate(0, -9, 0);
    searchBeam.position.set(0.4, -0.9, 0);
    group.add(searchBeam);
    group.position.z = -1.5;
    return { group, rotors, screws, pupil };
  }

  // ---------------------------------------------------------------- Scenery

  function makeEnvironment() {
    const pm = new T.PMREMGenerator(renderer);
    const envScene = new T.Scene();
    const geo = new T.SphereGeometry(50, 32, 16);
    const mat = new T.ShaderMaterial({
      side: T.BackSide,
      uniforms: {},
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "varying vec3 vP; void main(){ float y = vP.y; vec3 top = vec3(0.55,0.68,0.9); vec3 mid = vec3(0.12,0.24,0.42); vec3 low = vec3(0.02,0.04,0.08); vec3 c = y > 0.0 ? mix(mid, top, pow(y, 0.6)) : mix(mid, low, pow(-y, 0.5)); c += vec3(1.0,0.9,0.7) * pow(max(0.0, dot(vP, normalize(vec3(0.4,0.8,0.4)))), 32.0) * 2.0; gl_FragColor = vec4(c, 1.0); }",
    });
    envScene.add(new T.Mesh(geo, mat));
    const tex = pm.fromScene(envScene, 0.04).texture;
    pm.dispose();
    return tex;
  }

  function makeBackdrop() {
    const mat = new T.ShaderMaterial({
      depthWrite: false, fog: false,
      uniforms: { uWater: { value: 0.5 }, uCaptured: { value: 0 }, uTime: { value: 0 } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `varying vec2 vUv; uniform float uWater; uniform float uCaptured; uniform float uTime;
        void main(){
          float y = vUv.y;
          vec3 skyTop = mix(vec3(0.008,0.014,0.04), vec3(0.04,0.02,0.08), uCaptured);
          vec3 skyLow = mix(vec3(0.045,0.07,0.15), vec3(0.12,0.07,0.2), uCaptured);
          vec3 seaTop = mix(vec3(0.03,0.11,0.22), vec3(0.09,0.07,0.22), uCaptured);
          vec3 seaLow = vec3(0.008,0.02,0.045);
          vec3 c = y > uWater ? mix(skyLow, skyTop, smoothstep(uWater, 1.0, y)) : mix(seaLow, seaTop, pow(y / uWater, 1.6));
          float cloud = sin(vUv.x * 18.0 + uTime * 0.05) * sin(vUv.x * 7.0 - uTime * 0.03) * 0.5 + 0.5;
          if (y > uWater) c += vec3(0.05,0.06,0.09) * cloud * smoothstep(uWater + 0.05, uWater + 0.25, y) * (1.0 - smoothstep(0.85, 1.0, y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const m = new T.Mesh(new T.PlaneGeometry(260, 120), mat);
    m.position.set(7, -6, -70);
    // Put the water line of the backdrop behind the real surface.
    mat.uniforms.uWater.value = (0.4 - (-6 - 60)) / 120;
    m.userData.mat = mat;
    m.renderOrder = -10;
    return m;
  }

  function makeWater() {
    const geo = new T.PlaneGeometry(220, 70, 110, 35);
    geo.rotateX(-Math.PI / 2);
    const mat = new T.MeshStandardMaterial({ color: 0x1a4a78, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.45, side: T.DoubleSide, envMapIntensity: 0.8 });
    const m = new T.Mesh(geo, mat);
    m.position.set(7, 0, -25);
    m.userData.base = Float32Array.from(geo.attributes.position.array);
    return m;
  }

  // Light through moving water draws a web of bright lines on the seabed.
  function causticTexture() {
    return canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
      g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineCap = "round";
      for (let k = 0; k < 3; k++) {
        const f = 2 + k, a = 0.6 + k * 0.4;
        g.lineWidth = 1.6 - k * 0.3;
        for (let j = 0; j < 14; j++) {
          g.beginPath();
          for (let x = 0; x <= w; x += 4) {
            const y = (j / 14) * h + Math.sin((x / w) * Math.PI * f + j * a) * 9 + Math.sin((x / w) * Math.PI * (f + 3) * 2 + j) * 4;
            if (x === 0) g.moveTo(x, (y + h) % h); else g.lineTo(x, (y + h) % h);
          }
          g.stroke();
        }
        g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 2 + k * 0.4); g.translate(-w / 2, -h / 2);
        for (let j = 0; j < 12; j++) {
          g.beginPath();
          for (let x = 0; x <= w; x += 4) {
            const y = (j / 12) * h + Math.sin((x / w) * Math.PI * (f + 1) + j * 1.3) * 8;
            if (x === 0) g.moveTo(x, (y + h) % h); else g.lineTo(x, (y + h) % h);
          }
          g.stroke();
        }
        g.restore();
      }
      // Soften the web so it reads as light, not wire.
      g.globalAlpha = 0.5; g.filter = "blur(1.5px)"; g.drawImage(g.canvas, 0, 0); g.filter = "none"; g.globalAlpha = 1;
    }, [14, 5]);
  }

  function makeSeabed() {
    const geo = new T.PlaneGeometry(220, 70, 110, 35);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, Math.sin(x * 0.21) * 0.35 + Math.sin(z * 0.37 + x * 0.05) * 0.4 + Math.sin(x * 0.9 + z) * 0.08);
    }
    geo.computeVertexNormals();
    caustic = causticTexture();
    const m = new T.Mesh(geo, new T.MeshStandardMaterial({ color: 0x0d1d30, roughness: 1, metalness: 0, emissive: 0x7fb0e0, emissiveIntensity: 0.22, emissiveMap: caustic }));
    m.position.set(7, BOTTOM, -25);
    return m;
  }

  // Hull plating: seams every few plates and a row of rivets along each.
  function platingTexture() {
    return canvasTexture(1024, 256, (g, w, h) => {
      g.fillStyle = "#808080"; g.fillRect(0, 0, w, h);
      g.strokeStyle = "#4a4a4a"; g.lineWidth = 2;
      for (let x = 0; x < w; x += 96) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y < h; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.fillStyle = "#b8b8b8";
      for (let x = 8; x < w; x += 16) for (let y = 0; y < h; y += 64) { g.beginPath(); g.arc(x, y + 6, 2.2, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(x, y + 58, 2.2, 0, Math.PI * 2); g.fill(); }
      for (let x = 0; x < w; x += 96) for (let y = 10; y < h; y += 14) { g.beginPath(); g.arc(x + 6, y, 2.2, 0, Math.PI * 2); g.fill(); }
    }, [1, 1]);
  }

  function gradientTexture(stops) {
    const c = document.createElement("canvas"); c.width = 4; c.height = 128;
    const g = c.getContext("2d"); const gr = g.createLinearGradient(0, 0, 0, 128);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }

  // A light shaft fades along its length and across its width, so it reads
  // as light in water and not as a pane of glass.
  function shaftTexture() {
    const c = document.createElement("canvas"); c.width = 64; c.height = 256;
    const g = c.getContext("2d");
    const down = g.createLinearGradient(0, 0, 0, 256);
    down.addColorStop(0, "rgba(200,225,255,0.55)"); down.addColorStop(0.45, "rgba(200,225,255,0.16)"); down.addColorStop(1, "rgba(200,225,255,0)");
    g.fillStyle = down; g.fillRect(0, 0, 64, 256);
    g.globalCompositeOperation = "destination-in";
    const across = g.createLinearGradient(0, 0, 64, 0);
    across.addColorStop(0, "rgba(0,0,0,0)"); across.addColorStop(0.35, "rgba(0,0,0,1)"); across.addColorStop(0.65, "rgba(0,0,0,1)"); across.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = across; g.fillRect(0, 0, 64, 256);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }

  function makeShafts() {
    const tex = shaftTexture();
    const out = [];
    for (let i = 0; i < 14; i++) {
      const w = 0.9 + (i % 4) * 0.55;
      const m = new T.Mesh(new T.PlaneGeometry(w, 24), new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.05, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
      m.geometry.translate(0, -12, 0);
      m.userData = { x0: -14 + i * 4.3, z: -3 - (i % 5) * 5, phase: i * 1.7, base: 0.035 + (i % 3) * 0.012 };
      m.position.set(m.userData.x0, 0.4, m.userData.z);
      m.rotation.z = -0.24 - (i % 3) * 0.03;
      out.push(m);
    }
    return out;
  }

  function gearShape(R, teeth, hole) {
    const s = new T.Shape();
    for (let i = 0; i <= teeth * 4; i++) {
      const a = (i / (teeth * 4)) * Math.PI * 2;
      const r = i % 4 < 2 ? R : R * 0.84;
      if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    if (hole) { const h = new T.Path(); h.absarc(0, 0, R * hole, 0, Math.PI * 2, true); s.holes.push(h); }
    return s;
  }

  // Drowned ruins of the old world: towers, domes, arches, server stacks
  // and great gears. They scroll with the voyage and wrap around.
  function makeRuins() {
    const out = [];
    const stone = new T.MeshStandardMaterial({ color: 0x14304f, roughness: 0.95, metalness: 0.1 });
    const dark = new T.MeshStandardMaterial({ color: 0x0f243d, roughness: 0.9, metalness: 0.3 });
    const lights = new T.MeshStandardMaterial({ color: 0x000000, emissive: 0x4fa8e8, emissiveIntensity: 1.2 });
    const gearMat = metal(0x2b3a4f, 0.6, 0.8);
    let seed = 1870;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 34; i++) {
      const g = new T.Group();
      const kind = i % 5;
      const z = -7 - rnd() * 34;
      if (kind === 0) {
        const h = 4 + rnd() * 9;
        const tower = new T.Mesh(new T.BoxGeometry(1.2 + rnd() * 1.5, h, 1.2 + rnd()), stone);
        tower.position.y = h / 2; g.add(tower);
        if (rnd() < 0.6) { const dome = new T.Mesh(new T.SphereGeometry(0.9, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), stone); dome.position.y = h; g.add(dome); }
      } else if (kind === 1) {
        const arch = new T.Mesh(new T.TorusGeometry(2 + rnd() * 1.5, 0.35, 8, 24, Math.PI), stone);
        g.add(arch);
        for (const sx of [-1, 1]) { const leg = new T.Mesh(new T.BoxGeometry(0.7, 2.2, 0.7), stone); leg.position.set(sx * arch.geometry.parameters.radius, -1.1, 0); g.add(leg); }
        g.position.y = 2.2;
      } else if (kind === 2) {
        const R = 1.6 + rnd() * 2;
        const gear = new T.Mesh(new T.ExtrudeGeometry(gearShape(R, 14, 0.35), { depth: 0.35, bevelEnabled: false }), gearMat);
        gear.position.y = R * 0.7; gear.rotation.z = rnd(); gear.rotation.x = (rnd() - 0.5) * 0.6; g.add(gear);
        g.userData.spin = (rnd() - 0.5) * 0.08;
        g.userData.gear = gear;
      } else if (kind === 3) {
        const h = 2.5 + rnd() * 3.5;
        const rack = new T.Mesh(new T.BoxGeometry(1.1, h, 1.0), dark);
        rack.position.y = h / 2; g.add(rack);
        for (let k = 0; k < Math.floor(h / 0.35); k++) if (rnd() < 0.45) { const l = new T.Mesh(new T.PlaneGeometry(0.75, 0.04), lights); l.position.set(0, 0.3 + k * 0.35, 0.51); g.add(l); }
      } else {
        const col = new T.Mesh(new T.CylinderGeometry(0.4, 0.5, 3 + rnd() * 4, 12), stone);
        col.position.y = col.geometry.parameters.height / 2; col.rotation.z = (rnd() - 0.5) * 0.5; g.add(col);
      }
      g.position.set(0, BOTTOM + 0.1, z);
      g.userData.x0 = i * 4.4 + rnd() * 2;
      g.userData.z = z;
      out.push(g);
    }
    return out;
  }

  function makeKelp() {
    const out = [];
    const mat = new T.MeshStandardMaterial({ color: 0x245a52, roughness: 0.9, side: T.DoubleSide, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 40; i++) {
      const h = 1.5 + (i % 5) * 0.6;
      const geo = new T.PlaneGeometry(0.18, h, 1, 8); geo.translate(0, h / 2, 0);
      const m = new T.Mesh(geo, mat);
      m.userData = { x0: i * 3.3, z: -1 - (i % 6) * 3.5, phase: i, base: Float32Array.from(geo.attributes.position.array), h };
      m.position.set(0, BOTTOM, m.userData.z);
      out.push(m);
    }
    return out;
  }

  function dotTexture(soft) {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (soft) { gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.35, "rgba(255,255,255,0.6)"); gr.addColorStop(1, "rgba(255,255,255,0)"); }
    else { gr.addColorStop(0, "rgba(255,255,255,0.05)"); gr.addColorStop(0.7, "rgba(255,255,255,0.25)"); gr.addColorStop(0.85, "rgba(255,255,255,0.9)"); gr.addColorStop(1, "rgba(255,255,255,0)"); }
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new T.CanvasTexture(c);
  }

  function makeSnow() {
    const n = 900, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = -20 + Math.random() * 60; pos[i * 3 + 1] = BOTTOM + Math.random() * (0 - BOTTOM); pos[i * 3 + 2] = -30 + Math.random() * 36; }
    const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    return new T.Points(geo, new T.PointsMaterial({ size: 0.07, map: dotTexture(true), transparent: true, opacity: 0.55, depthWrite: false, color: 0xcfe2ff }));
  }

  // Volcanic vents: columns of hot water and sparks rising from the seabed.
  function makeVents() {
    const n = 420, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = i % 6, life = Math.random();
      pos[i * 3] = -14 + v * 7 + (Math.random() - 0.5) * 1.2; pos[i * 3 + 1] = BOTTOM + life * 9; pos[i * 3 + 2] = -6 - (v % 3) * 4 + (Math.random() - 0.5) * 1.5;
      col[i * 3] = 1; col[i * 3 + 1] = 0.55 + Math.random() * 0.2; col[i * 3 + 2] = 0.2;
    }
    const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("color", new T.BufferAttribute(col, 3));
    const p = new T.Points(geo, new T.PointsMaterial({ size: 0.26, map: dotTexture(true), vertexColors: true, transparent: true, opacity: 1, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
    p.frustumCulled = false;
    return p;
  }

  // A pool of particles in one draw call.
  function makePool(n, additive) {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    geo.setAttribute("color", new T.BufferAttribute(col, 3));
    const mat = new T.PointsMaterial({ size: additive ? 0.16 : 0.13, vertexColors: true, transparent: true, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending, opacity: additive ? 1 : 0.8 });
    const points = new T.Points(geo, mat);
    points.frustumCulled = false;
    const items = [];
    return {
      points, mat, items,
      add(p) { if (items.length < n) items.push(p); },
      update(dt, rise) {
        let k = 0;
        for (let i = items.length - 1; i >= 0; i--) {
          const p = items[i];
          p.life -= dt;
          if (p.life <= 0) { items.splice(i, 1); continue; }
          p.vx *= p.drag || 0.94; p.vy = p.vy * (p.drag || 0.94) + (rise ? 1.2 * dt : 0); p.vz *= p.drag || 0.94;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (rise && p.y > -0.05) p.life = 0;
        }
        for (const p of items) {
          const f = Math.max(0, p.life / p.max);
          pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
          col[k * 3] = p.r * f; col[k * 3 + 1] = p.g * f; col[k * 3 + 2] = p.b * f;
          k++;
        }
        geo.setDrawRange(0, k);
        geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      },
    };
  }

  function burst(x, y, z, n, color, speed, life) {
    const c = new T.Color(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), s = speed * (0.3 + Math.random() * 0.7);
      sparks.add({ x, y, z, vx: Math.sin(b) * Math.cos(a) * s, vy: Math.sin(b) * Math.sin(a) * s, vz: Math.cos(b) * s * 0.5, life: life * (0.6 + Math.random() * 0.4), max: life, r: c.r, g: c.g, b: c.b });
    }
  }
  function bubbleBurst(x, y, z, n, spread) {
    for (let i = 0; i < n; i++) bubbles.add({ x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 0.8, vy: 0.6 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.4, life: 2 + Math.random() * 2, max: 4, r: 0.75, g: 0.85, b: 1, drag: 0.985 });
  }
  function ring(x, y, color, size, life) {
    const m = new T.Mesh(new T.TorusGeometry(1, 0.05, 6, 48), new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
    m.position.set(x, y, 0.2);
    scene.add(m);
    while (rings.length >= MAX_RINGS) dropRing(0);
    rings.push({ m, life, max: life, size });
  }
  // Point lights are the dearest thing in the scene, so only a few flashes
  // live at once and the oldest gives way.
  const MAX_FLASHES = 4, MAX_RINGS = 8;
  function flashAt(x, y, color, intensity, life) {
    while (flashes.length >= MAX_FLASHES) dropFlash(0);
    const l = new T.PointLight(color, intensity, 14, 1.6);
    l.position.set(x, y, 1.2);
    scene.add(l);
    const s = new T.Sprite(new T.SpriteMaterial({ map: glowMap || (glowMap = dotTexture(true)), color, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
    s.position.set(x, y, 0.3); scene.add(s);
    flashes.push({ l, s, life, max: life, intensity });
  }

  // ---------------------------------------------------------------- Game objects

  const sharedGeo = {};
  function g(name, make) { return sharedGeo[name] || (sharedGeo[name] = make()); }

  function makePayload(p) {
    const grp = new T.Group();
    const iron = metal(0x1b2030, 0.5, 0.8), brass = metal(0xc49a55, 0.3, 1);
    if (p.kind === "charge") {
      grp.add(new T.Mesh(g("chargeBody", () => new T.CylinderGeometry(0.24, 0.24, 0.55, 16)), iron));
      for (const y of [-0.22, 0, 0.22]) { const b = new T.Mesh(g("chargeBand", () => new T.TorusGeometry(0.245, 0.03, 6, 20)), brass); b.rotation.x = Math.PI / 2; b.position.y = y; grp.add(b); }
      const light = new T.Mesh(g("dot", () => new T.SphereGeometry(0.06, 10, 10)), glow(0xffd99a, 4)); light.position.y = 0.34; grp.add(light);
      grp.userData.blink = light;
      // A faint marker at the depth where the charge will burst.
      const marker = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(-1.1, 0, 0), new T.Vector3(1.1, 0, 0)]), new T.LineDashedMaterial({ color: 0xe6d3a1, dashSize: 0.18, gapSize: 0.14, transparent: true, opacity: 0.4 }));
      marker.computeLineDistances();
      scene.add(marker);
      grp.userData.marker = marker;
    } else if (p.kind === "fog") {
      grp.add(new T.Mesh(g("fogBody", () => new T.SphereGeometry(0.26, 16, 16)), metal(0x3c3a58, 0.6, 0.5)));
      grp.userData.puff = true;
    } else if (p.kind === "decoy") {
      const c = new T.Mesh(g("decoyBody", () => new T.ConeGeometry(0.22, 0.6, 12)), metal(0xaab4cc, 0.3, 1)); c.rotation.z = Math.PI; grp.add(c);
      const r = new T.Mesh(g("decoyRing", () => new T.TorusGeometry(0.4, 0.02, 6, 32)), new T.MeshBasicMaterial({ color: 0xc9d4ff, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
      grp.add(r); grp.userData.ping = r;
    } else if (p.kind === "ember") {
      grp.add(new T.Mesh(g("emberBody", () => new T.IcosahedronGeometry(0.26, 2)), glow(0xff8a3c, 5)));
      const l = new T.PointLight(0xff8a3c, 18, 6, 1.6); grp.add(l);
    } else if (p.kind === "boarder") {
      grp.add(new T.Mesh(g("boarderBody", () => new T.SphereGeometry(0.26, 16, 12)), metal(0x3a4357, 0.4, 0.9)));
      const eye = new T.Mesh(g("dot", () => new T.SphereGeometry(0.06, 10, 10)), glow(0x9fd0ff, 5)); eye.position.set(0.12, 0.05, 0.2); grp.add(eye);
      const legs = [];
      for (let i = 0; i < 8; i++) {
        const leg = new T.Mesh(g("leg", () => { const ge = new T.CylinderGeometry(0.015, 0.015, 0.55, 4); ge.translate(0, -0.27, 0); return ge; }), metal(0x8b95ab, 0.4, 0.9));
        leg.position.set(i < 4 ? -0.12 : 0.12, 0, -0.15 + (i % 4) * 0.1); leg.rotation.z = (i < 4 ? 1 : -1) * 0.9; grp.add(leg); legs.push(leg);
      }
      grp.userData.legs = legs;
    } else if (p.kind === "siren") {
      const k = new T.Mesh(g("sirenBody", () => new T.TorusKnotGeometry(0.2, 0.06, 64, 8)), glow(0xb9a6ff, 3.5)); grp.add(k); grp.userData.spin = k;
    } else if (p.kind === "writ") {
      const parch = new T.Mesh(new T.BoxGeometry(1.5, 0.95, 0.04), new T.MeshStandardMaterial({ color: 0xe6d3a1, roughness: 0.9 }));
      grp.add(parch);
      for (const x of [-0.8, 0.8]) { const roll = new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 1.1, 12), metal(0xc9b27d, 0.5, 0.4)); roll.position.x = x; grp.add(roll); }
      const ink = new T.MeshBasicMaterial({ color: 0x3a2814 });
      for (let i = 0; i < 5; i++) { const line = new T.Mesh(new T.PlaneGeometry(0.9 - (i % 2) * 0.2, 0.025), ink); line.position.set(-0.08, 0.28 - i * 0.12, 0.025); grp.add(line); }
      const seal = new T.Mesh(new T.CylinderGeometry(0.16, 0.16, 0.04, 20), metal(0x7a2433, 0.5, 0.3)); seal.rotation.x = Math.PI / 2; seal.position.set(0.42, -0.25, 0.04); grp.add(seal);
      const aura = new T.Mesh(new T.SphereGeometry(1.2, 20, 20), new T.MeshBasicMaterial({ color: 0xb9a6ff, transparent: true, opacity: 0.08, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
      grp.add(aura);
      const pips = [];
      for (let i = 0; i < 3; i++) { const pip = new T.Mesh(new T.BoxGeometry(0.28, 0.07, 0.04), glow(0xd8ccff, 3)); pip.position.set(-0.36 + i * 0.36, 0.72, 0); grp.add(pip); pips.push(pip); }
      grp.userData.pips = pips;
      grp.userData.writ = true;
    }
    scene.add(grp);
    return grp;
  }

  function makeGearMesh() {
    const m = new T.Mesh(g("gear", () => { const ge = new T.ExtrudeGeometry(gearShape(0.3, 10, 0.3), { depth: 0.08, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 }); ge.center(); return ge; }), new T.MeshStandardMaterial({ color: 0xe6c27a, metalness: 1, roughness: 0.22, emissive: 0x3a2a08, emissiveIntensity: 0.6 }));
    scene.add(m);
    return m;
  }

  function makeHarpoon() {
    const grp = new T.Group();
    const shaft = new T.Mesh(g("hShaft", () => { const ge = new T.CylinderGeometry(0.02, 0.02, 0.6, 6); ge.rotateZ(Math.PI / 2); ge.translate(-0.3, 0, 0); return ge; }), metal(0xf0d9a0, 0.25, 1));
    const tip = new T.Mesh(g("hTip", () => { const ge = new T.ConeGeometry(0.05, 0.16, 8); ge.rotateZ(-Math.PI / 2); return ge; }), metal(0xdfe6ff, 0.2, 1));
    grp.add(shaft, tip);
    const line = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), new T.LineBasicMaterial({ color: 0xc9b27d, transparent: true, opacity: 0.5 }));
    scene.add(line);
    grp.userData.line = line;
    scene.add(grp);
    return grp;
  }

  // Salvage.
  function makeRelic() {
    const grp = new T.Group();
    const body = new T.Mesh(g("relicBody", () => new T.CylinderGeometry(0.16, 0.16, 0.5, 12)), metal(0xc49a55, 0.35, 1));
    const b1 = new T.Mesh(g("relicBand", () => new T.TorusGeometry(0.165, 0.03, 6, 16)), metal(0x3d2b14, 0.5, 0.8)); b1.rotation.x = Math.PI / 2; b1.position.y = 0.2;
    const b2 = b1.clone(); b2.position.y = -0.2;
    const gem = new T.Mesh(g("dot", () => new T.SphereGeometry(0.06, 10, 10)), glow(0xf0d9a0, 3)); gem.position.z = 0.17;
    grp.add(body, b1, b2, gem);
    scene.add(grp);
    return grp;
  }
  function makeChest() {
    const grp = new T.Group();
    const wood = new T.MeshStandardMaterial({ color: 0x4a3418, roughness: 0.85, metalness: 0.1 });
    const box = new T.Mesh(g("chestBox", () => new T.BoxGeometry(1.1, 0.55, 0.7)), wood); box.position.y = 0.28;
    const lid = new T.Mesh(g("chestLid", () => new T.CylinderGeometry(0.36, 0.36, 1.1, 12, 1, false, 0, Math.PI)), wood);
    lid.rotation.z = Math.PI / 2; lid.rotation.y = Math.PI; lid.position.set(0, 0.56, 0);
    const bandMat = metal(0xc49a55, 0.3, 1);
    for (const x of [-0.35, 0.35]) { const band = new T.Mesh(g("chestBand", () => new T.BoxGeometry(0.1, 0.95, 0.74)), bandMat); band.position.set(x, 0.47, 0); grp.add(band); }
    const lock = new T.Mesh(g("chestLock", () => new T.BoxGeometry(0.2, 0.2, 0.06)), bandMat); lock.position.set(0, 0.4, 0.37);
    const light = new T.PointLight(0xf0d9a0, 6, 4, 1.8); light.position.set(0, 0.9, 0.5);
    grp.add(box, lid, lock, light);
    grp.userData.light = light;
    scene.add(grp);
    return grp;
  }
  function makeClam() {
    const grp = new T.Group();
    const shellMat = new T.MeshStandardMaterial({ color: 0x6f94b0, roughness: 0.45, metalness: 0.15 });
    const half = () => new T.Mesh(g("clamShell", () => { const ge = new T.SphereGeometry(0.9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2); ge.scale(1, 0.45, 0.8); return ge; }), shellMat);
    const lower = half(); lower.rotation.x = Math.PI; lower.position.y = 0.4;
    const hinge = new T.Group(); hinge.position.set(0, 0.4, -0.7);
    const upper = half(); upper.position.set(0, 0, 0.7);
    hinge.add(upper);
    const pearl = new T.Mesh(g("pearl", () => new T.SphereGeometry(0.16, 16, 16)), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.1, emissive: 0xdde8ff, emissiveIntensity: 0.8 }));
    pearl.position.set(0, 0.52, 0);
    const light = new T.PointLight(0xdde8ff, 0, 4, 1.8); light.position.set(0, 1, 0);
    grp.add(lower, hinge, pearl, light);
    grp.userData = { hinge, pearl, light };
    scene.add(grp);
    return grp;
  }

  function sync(list, prefix, make, place) {
    const seen = new Set();
    for (const o of list) {
      const key = prefix + o.id;
      seen.add(key);
      let m = meshes.get(key);
      if (!m) { m = make(o); meshes.set(key, m); }
      place(m, o);
    }
    for (const [key, m] of meshes) {
      if (!key.startsWith(prefix) || seen.has(key)) continue;
      remove(m);
      meshes.delete(key);
    }
  }
  function remove(m) {
    scene.remove(m);
    if (m.userData.marker) scene.remove(m.userData.marker);
    if (m.userData.line) scene.remove(m.userData.line);
  }

  // ---------------------------------------------------------------- Events

  function event(e, v) {
    const ex = e.x !== undefined ? X(e.x) : 0, ey = e.y !== undefined ? Y(e.y) : 0;
    if (e.type === "intercept") { burst(ex, ey, 0.3, 70, 0xf0d9a0, 6, 0.8); ring(ex, ey, 0xf0d9a0, 1.6, 0.5); flashAt(ex, ey, 0xffe0a0, 40, 0.25); bubbleBurst(ex, ey, 0, 10, 0.6); }
    else if (e.type === "dent") { burst(ex, ey, 0.3, 24, 0xd8ccff, 4, 0.5); }
    else if (e.type === "blast") { burst(ex, ey, 0.3, 140, 0xffd99a, 9, 1); ring(ex, ey, 0xffe6be, 3.2, 0.8); flashAt(ex, ey, 0xffc880, 160, 0.5); bubbleBurst(ex, ey, 0, 60, 1.6); }
    else if (e.type === "contact") {
      const col = { fog: 0x8a86b5, decoy: 0xc9d4ff, ember: 0xff9a4a, boarder: 0x9fd0ff, siren: 0xb9a6ff, writ: 0xd8ccff }[e.kind] || 0xffffff;
      burst(ex, ey, 0.3, 80, col, 5, 1.1); ring(X(C.SUB_X), Y(v.sub.y), col, 3, 0.7);
      if (e.kind === "writ") flashAt(X(C.SUB_X), Y(v.sub.y), 0xb9a6ff, 120, 0.8);
    } else if (e.type === "gear") { burst(ex, ey, 0.3, 20, 0xe6c27a, 3, 0.5); }
    else if (e.type === "relic") { burst(ex, ey, 0.3, 24, 0xf0d9a0, 3, 0.6); }
    else if (e.type === "chest") { burst(ex, ey + 0.5, 0.3, 60, 0xf0d9a0, 4, 0.9); flashAt(ex, ey + 0.5, 0xf0d9a0, 50, 0.5); }
    else if (e.type === "pearl") { burst(ex, ey, 0.3, 80, 0xdde8ff, 4, 1.1); ring(ex, ey, 0xdde8ff, 3, 0.9); flashAt(ex, ey, 0xdde8ff, 80, 0.7); }
    else if (e.type === "caught") { ring(X(C.SUB_X), Y(v.sub.y), 0xe6d3a1, 3.6, 0.9); }
    else if (e.type === "hit") { flashAt(X(C.SUB_X), Y(v.sub.y), 0xf2b48a, 90, 0.4); bubbleBurst(X(C.SUB_X), Y(v.sub.y), 0, 40, 2); }
  }

  // ---------------------------------------------------------------- Frame

  function render(v, dt, view) {
    clock += dt;
    const t = v.t;
    const scroll = v.dist / U;
    if (view.skin !== currentSkin) applySkin(view.skin);
    if (view.pennant !== currentPennant) applyPennant(view.pennant);

    // Camera: chase framing with a slow sway and a shake on hits.
    applySea(v, dt);
    // The camera closes in when the Decree is in the water or in force, and
    // frames the tunnel tighter.
    const hz = v.hazards || {};
    const writIn = v.payloads.some((p) => p.kind === "writ");
    const zoomTarget = v.rulesCaptured || writIn ? 0.8 : hz.current ? 0.9 : 1;
    zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt / 0.8));
    const d = (camera.userData.dist || 26) * zoom;
    const sh = view.reduced ? 0 : view.shake * 0.35;
    const lx = LOOK.x + (1 - zoom) * 8;
    // The opening shot starts high by the airship and settles on the ship.
    if (view.reduced) intro = 0;
    intro = Math.max(0, intro - dt / 3.2);
    const k = intro * intro * (3 - 2 * intro);
    camera.position.set(lx + Math.sin(clock * 0.15) * 0.8 + (Math.random() - 0.5) * sh + k * 9, LOOK.y + 0.6 + Math.sin(clock * 0.11) * 0.3 + (Math.random() - 0.5) * sh + k * 9, d + k * 10);
    camera.lookAt(lx + k * 6, LOOK.y + (1 - zoom) * 2 + k * 5, 0);

    // Captured rules tint the whole sea.
    const capture = v.rulesCaptured ? 1 : 0;
    scene.fog.color.lerp(capture ? fogCaptured : fogBase, Math.min(1, dt * 2));
    const bd = scene.children.find((c) => c.userData.mat);
    if (bd) { bd.userData.mat.uniforms.uCaptured.value += (capture - bd.userData.mat.uniforms.uCaptured.value) * Math.min(1, dt * 2); bd.userData.mat.uniforms.uTime.value = clock; }
    bloom.strength = 0.75 + (view.reduced ? 0 : view.flash * 0.8) + (seaFx && seaFx.lightning > 0 ? seaFx.lightning * 1.5 : 0);

    // Water surface.
    const wp = water.geometry.attributes.position, base = water.userData.base;
    for (let i = 0; i < wp.count; i++) {
      const x = base[i * 3] + scroll, z = base[i * 3 + 2];
      wp.setY(i, (Math.sin(x * 0.35 + clock * 1.6) * 0.12 + Math.sin(z * 0.5 + x * 0.12 - clock * 1.1) * 0.1) * swellAmp);
    }
    wp.needsUpdate = true;
    water.geometry.computeVertexNormals();

    // Scenery scrolls and wraps.
    const wrap = (x0, speed, span, lo) => ((((x0 - scroll * speed) % span) + span) % span) + lo;
    for (const r of ruins) {
      r.position.x = wrap(r.userData.x0, 1, 150, -45);
      if (r.userData.gear) r.userData.gear.rotation.z += r.userData.spin * dt;
    }
    for (const s of shafts) { s.position.x = wrap(s.userData.x0, 0.6, 60, -20) + Math.sin(clock * 0.3 + s.userData.phase) * 0.6; s.material.opacity = (s.userData.base + 0.02 * Math.sin(clock * 0.7 + s.userData.phase)) * (s.userData.level === undefined ? 1 : s.userData.level); }
    for (const k of kelp) {
      k.position.x = wrap(k.userData.x0, 1, 132, -40);
      const p = k.geometry.attributes.position, b = k.userData.base;
      for (let i = 0; i < p.count; i++) { const y = b[i * 3 + 1]; p.setX(i, b[i * 3] + Math.sin(clock * 1.3 + k.userData.phase + y * 0.8) * 0.18 * (y / k.userData.h)); }
      p.needsUpdate = true;
    }
    seabed.position.x = 7 - (scroll % 30);
    if (caustic) { caustic.offset.x = clock * 0.012 + scroll * 0.004; caustic.offset.y = Math.sin(clock * 0.2) * 0.03; }
    applyConditions(v, dt);
    const sp = snow.geometry.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      let x = sp.getX(i) - (v.sub.speed * 3.5 + 0.08) * dt, y = sp.getY(i) - 0.12 * dt;
      if (x < -20) x += 60; if (y < BOTTOM) y = -0.2;
      sp.setX(i, x); sp.setY(i, y);
    }
    sp.needsUpdate = true;

    // The Nautilus.
    const sy = Y(v.sub.y);
    sub.group.position.set(0, sy, 0);
    sub.group.rotation.z = T.MathUtils.clamp((v.sub.y - v.sub.targetY) * 0.002, -0.18, 0.18);
    sub.group.rotation.x = Math.sin(clock * 0.8) * 0.03;
    sub.screw.rotation.x += dt * (3 + 22 * v.sub.speed);
    sub.group.visible = !(v.invuln > 0 && Math.floor(t * 12) % 2 === 0);
    if (sub.pennant.visible) {
      const pp = sub.pennant.geometry.attributes.position, pb = sub.penBase;
      for (let i = 0; i < pp.count; i++) { const x = pb[i * 3]; pp.setZ(i, Math.sin(clock * 7 + x * 6) * 0.06 * (0.35 - x)); }
      pp.needsUpdate = true;
    }
    if (dt > 0 && v.sub.speed > 0.05) for (let i = 0; i < 2; i++) if (Math.random() < v.sub.speed) bubbles.add({ x: -3.4, y: sy + (Math.random() - 0.5) * 0.3, z: (Math.random() - 0.5) * 0.3, vx: -2 - Math.random() * 2 * v.sub.speed, vy: 0.3 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.4, life: 1.6, max: 1.6, r: 0.7, g: 0.82, b: 1, drag: 0.97 });

    // The Albatross.
    const ax = X(C.airshipX(t));
    airship.group.position.set(ax, Y(92) + Math.sin(clock * 0.6) * 0.12, -1.5);
    airship.group.rotation.z = Math.sin(clock * 0.4) * 0.025;
    for (const r of airship.rotors) r.rotation.y += dt * 26;
    for (const s of airship.screws) s.rotation.x += dt * 14;
    airship.pupil.material.emissiveIntensity = (capture ? 8 : 4) + Math.sin(clock * 3) * 1.5;
    const sweep = Math.sin(clock * 0.9) * 0.35;
    searchBeam.rotation.z = sweep;
    searchLight.target.position.set(0.4 + Math.sin(sweep) * 18, -18, 0);

    // Payloads, gears and harpoons.
    sync(v.payloads, "p", makePayload, (m, p) => {
      m.position.set(X(p.x), Y(p.y), 0);
      if (p.kind === "charge") {
        m.rotation.z = Math.sin(clock * 3 + p.id) * 0.2;
        m.userData.blink.visible = Math.sin(clock * 14) > 0;
        m.userData.marker.position.set(X(p.x), Y(p.fuseY), 0);
      } else if (m.userData.ping) { const k = (clock * 1.4 + p.id * 0.3) % 1; m.userData.ping.scale.setScalar(1 + k * 3); m.userData.ping.material.opacity = 1 - k; }
      else if (m.userData.legs) m.userData.legs.forEach((l, i) => { l.rotation.x = Math.sin(clock * 14 + i) * 0.4; });
      else if (m.userData.spin) { m.userData.spin.rotation.x += dt * 3; m.userData.spin.rotation.y += dt * 2; }
      else if (m.userData.writ) { m.rotation.z = Math.sin(clock * 1.2) * 0.1; m.userData.pips.forEach((pip, i) => { pip.visible = i < p.hp; }); }
      else if (m.userData.puff && dt > 0 && Math.random() < 0.5) bubbles.add({ x: X(p.x) + (Math.random() - 0.5) * 0.3, y: Y(p.y) + 0.2, z: 0, vx: (Math.random() - 0.5) * 0.4, vy: 0.4, vz: 0, life: 1.2, max: 1.2, r: 0.55, g: 0.52, b: 0.75, drag: 0.98 });
    });
    sync(v.gears, "g", makeGearMesh, (m, gr) => { m.position.set(X(gr.x), Y(gr.y), 0); m.rotation.z = clock * 2 + gr.phase; m.rotation.y = Math.sin(clock + gr.phase) * 0.6; });
    sync(v.relics, "r", makeRelic, (m, rl) => { m.position.set(X(rl.x), Y(rl.y), 0); m.rotation.z = Math.sin(clock * 2 + rl.id) * 0.4; m.rotation.y = clock * 1.5; });
    sync(v.chests, "c", makeChest, (m, c) => { m.position.set(X(c.x), Y(c.y) - 0.1, 0); m.userData.light.intensity = 4 + Math.sin(clock * 3) * 2; });
    sync(v.clams, "k", makeClam, (m, cl) => {
      m.position.set(X(cl.x), Y(cl.y) - 0.3, 0);
      const open = cl.done ? 0.95 : cl.open * 0.95;
      m.userData.hinge.rotation.x = -open * 1.2;
      m.userData.pearl.visible = !cl.done;
      m.userData.light.intensity = cl.done ? 0 : open * 10;
    });
    sync(v.harpoons, "h", makeHarpoon, (m, h) => {
      m.position.set(X(h.x), Y(h.y), 0.1);
      m.rotation.z = -(h.angle || -Math.PI / 2);
      const lp = m.userData.line.geometry.attributes.position;
      lp.setXYZ(0, 1.55, sy + 1.05, 0); lp.setXYZ(1, X(h.x), Y(h.y), 0.1); lp.needsUpdate = true;
    });

    tickEffects(dt);

    if (view.scene === "salon") { renderSalon(dt); return; }
    composer.render(dt);
  }

  // Ages sparks, bubbles, rings and flashes. Called every frame, and by
  // settle() when a voyage is stepped faster than it is drawn.
  function tickEffects(dt) {
    sparks.update(dt, false);
    bubbles.update(dt, true);
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]; r.life -= dt;
      if (r.life <= 0) { dropRing(i); continue; }
      const k = 1 - r.life / r.max; r.m.scale.setScalar(0.2 + k * r.size); r.m.material.opacity = (1 - k) * 0.9;
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]; f.life -= dt;
      if (f.life <= 0) { dropFlash(i); continue; }
      const k = f.life / f.max; f.l.intensity = f.intensity * k; f.s.scale.setScalar(1 + (1 - k) * 2.5); f.s.material.opacity = k * 0.7;
    }
  }
  function dropRing(i) { const r = rings[i]; scene.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); rings.splice(i, 1); }
  function dropFlash(i) { const f = flashes[i]; scene.remove(f.l, f.s); f.s.material.dispose(); flashes.splice(i, 1); }

  // ---------------------------------------------------------------- Seas and weather

  // Each chapter has a sea. Lighting, fog, water colour and a few set
  // dressings change, and the gameplay plane stays the same.
  function applySea(v, dt) {
    const sea = v.chapter ? v.chapter.sea : "open";
    const weather = v.chapter ? v.chapter.weather : "clear";
    const key = sea + "/" + weather + "/" + (v.depthMin || C.DEPTH_MIN) + "/" + (v.depthMax || C.DEPTH_MAX);
    if (key !== seaKey) {
      seaKey = key;
      if (seaFx) { for (const o of seaFx.objects) scene.remove(o); }
      kelp = kelp.filter((k) => !k.userData.sea);
      seaFx = { objects: [], lightning: 0, rain: null, ring: null };
      const night = weather === "night" || weather === "dark";
      hemi.intensity = night ? 0.22 : weather === "bright" ? 1.1 : 0.85;
      moon.intensity = night ? 0.35 : weather === "bright" ? 2.2 : 1.6;
      lanternBase = night ? 420 : 220; lantern.intensity = lanternBase;
      fogBase.set(sea === "kelp" ? 0x0a2a1e : sea === "reef" ? 0x1a4a6a : sea === "ice" ? 0x0a1a2e : sea === "tunnel" ? 0x12100c : sea === "vortex" ? 0x0a0e22 : 0x0b2746);
      scene.fog.density = sea === "kelp" ? 0.045 : sea === "ice" ? 0.04 : sea === "tunnel" ? 0.035 : sea === "reef" ? 0.02 : 0.03;
      seaFx.density = scene.fog.density;
      water.material.color.set(sea === "reef" ? 0x2a8aa8 : sea === "ice" ? 0x9fc8e8 : sea === "vortex" ? 0x14304a : 0x1a4a78);
      seabed.material.color.set(sea === "reef" ? 0x8a7a5a : sea === "ice" ? 0x1a2a3e : sea === "tunnel" ? 0x1a1410 : 0x0d1d30);
      seabed.position.y = Y(v.depthMax || C.DEPTH_MAX) - 0.2;
      for (const k of kelp) k.visible = sea !== "ice" && sea !== "tunnel";
      for (const rn of ruins) rn.visible = sea === "city" || sea === "open" || sea === "vortex";
      // Daylight reaches the water as shafts. Night dims them, ice scatters
      // them, and the tunnel has none.
      const shaftLevel = sea === "tunnel" ? 0 : night ? 0.35 : sea === "ice" ? 0.6 : weather === "bright" ? 1.4 : weather === "storm" ? 0.5 : 1;
      for (const s of shafts) { s.visible = shaftLevel > 0; s.userData.level = shaftLevel; }
      const add = (o) => { scene.add(o); seaFx.objects.push(o); return o; };
      if (sea === "kelp") {
        const mat = new T.MeshStandardMaterial({ color: 0x1f5a4a, roughness: 0.9, side: T.DoubleSide, transparent: true, opacity: 0.9 });
        for (let i = 0; i < 70; i++) {
          const h = 6 + (i % 7) * 1.4;
          const geo = new T.PlaneGeometry(0.3, h, 1, 10); geo.translate(0, h / 2, 0);
          const m = new T.Mesh(geo, mat);
          m.userData = { x0: i * 2.1, z: -2 - (i % 8) * 3, phase: i, base: Float32Array.from(geo.attributes.position.array), h };
          m.position.set(0, BOTTOM, m.userData.z);
          kelp.push(m); add(m); m.userData.sea = "kelp";
        }
      }
      if (sea === "reef") {
        const corals = [0xd66a5a, 0xe8a04a, 0x9a5ad6, 0x5ad6c4];
        for (let i = 0; i < 40; i++) {
          const g = new T.Group();
          for (let k = 0; k < 4; k++) { const b = new T.Mesh(new T.SphereGeometry(0.3 + Math.random() * 0.5, 8, 6), new T.MeshStandardMaterial({ color: corals[(i + k) % 4], roughness: 0.8 })); b.position.set((Math.random() - 0.5) * 1.2, Math.random() * 0.8, (Math.random() - 0.5) * 1.2); g.add(b); }
          g.position.set(0, Y(v.depthMax) - 0.1, -1 - (i % 6) * 2.5); g.userData = { x0: i * 3.7, scrollReef: true };
          add(g);
        }
      }
      if (sea === "ice") {
        const ceiling = new T.Mesh(new T.PlaneGeometry(220, 60), new T.MeshStandardMaterial({ color: 0xbfe0ff, roughness: 0.6, metalness: 0.1, emissive: 0x3a6a9a, emissiveIntensity: 0.25, side: T.DoubleSide }));
        ceiling.rotation.x = Math.PI / 2; ceiling.position.set(7, Y(v.depthMin) + 1.2, -20);
        add(ceiling);
        for (let i = 0; i < 30; i++) { const spike = new T.Mesh(new T.ConeGeometry(0.4 + Math.random() * 0.6, 2 + Math.random() * 3, 6), ceiling.material); spike.rotation.x = Math.PI; spike.position.set(0, Y(v.depthMin) + 1.2 - 1, -1 - (i % 6) * 3); spike.userData = { x0: i * 4.4, scrollReef: true }; add(spike); }
      }
      if (sea === "tunnel") {
        const rock = new T.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 });
        const top = new T.Mesh(new T.BoxGeometry(220, 6, 40), rock); top.position.set(7, Y(v.depthMin) + 3.5, -14); add(top);
        for (let i = 0; i < 40; i++) { const stal = new T.Mesh(new T.ConeGeometry(0.5 + Math.random(), 2 + Math.random() * 4, 7), rock); stal.rotation.x = Math.PI; stal.position.set(0, Y(v.depthMin) + 0.5, -1 - (i % 7) * 2.5); stal.userData = { x0: i * 3.3, scrollReef: true }; add(stal); }
      }
      if (sea === "vortex") {
        const n = 1200, pos = new Float32Array(n * 3);
        const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
        const ringPts = new T.Points(geo, new T.PointsMaterial({ size: 0.12, color: 0x9fc8ff, transparent: true, opacity: 0.5, depthWrite: false, blending: T.AdditiveBlending }));
        ringPts.frustumCulled = false; ringPts.userData.vortex = true; add(ringPts); seaFx.ring = ringPts;
      }
      if (weather === "storm") {
        const n = 1500, pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { pos[i * 3] = -20 + Math.random() * 60; pos[i * 3 + 1] = Math.random() * 12; pos[i * 3 + 2] = -10 + Math.random() * 14; }
        const geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
        const rain = new T.Points(geo, new T.PointsMaterial({ size: 0.05, color: 0xbfd2f2, transparent: true, opacity: 0.6, depthWrite: false }));
        rain.frustumCulled = false; add(rain); seaFx.rain = rain;
      }
    }
    if (!seaFx) return;
    // Per-frame weather.
    const scroll = v.dist / U;
    for (const o of seaFx.objects) {
      if (o.userData.scrollReef) o.position.x = ((((o.userData.x0 - scroll) % 150) + 150) % 150) - 45;
    }
    if (seaFx.rain) {
      const p = seaFx.rain.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { let y = p.getY(i) - 18 * dt, x = p.getX(i) - 6 * dt; if (y < 0) { y = 12; } if (x < -20) x += 60; p.setY(i, y); p.setX(i, x); }
      p.needsUpdate = true;
      if (Math.random() < dt * 0.25) seaFx.lightning = 1;
    }
    if (seaFx.lightning > 0) { seaFx.lightning = Math.max(0, seaFx.lightning - dt * 4); moon.intensity = 1.6 + seaFx.lightning * 6; }
    if (seaFx.ring) {
      const p = seaFx.ring.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { const a = clock * 0.6 + i * 0.013, rr = 9 + (i % 40) * 0.35; p.setXYZ(i, 16 + Math.cos(a) * rr * 1.6, -4 + Math.sin(a) * rr * 0.5, -8 - (i % 9)); }
      p.needsUpdate = true;
    }
  }

  // Sea conditions dress the water while they are in force.
  function applyConditions(v, dt) {
    const on = v.active || new Set();
    const vent = on.has("vent"), silt = on.has("silt"), swell = on.has("swell"), unrest = on.has("unrest");
    swellAmp += ((swell ? 3.2 : 1) - swellAmp) * Math.min(1, dt * 0.8);
    const density = (seaFx && seaFx.density) || 0.03;
    scene.fog.density += ((silt ? density * 1.7 : density) - scene.fog.density) * Math.min(1, dt * 0.8);
    snow.material.color.lerp(silt ? siltColor : snowColor, Math.min(1, dt * 0.8));
    snow.material.size += ((silt ? 0.13 : 0.07) - snow.material.size) * Math.min(1, dt * 0.8);
    seabed.material.emissive.lerp(vent ? ventGlow : causticGlow, Math.min(1, dt * 0.8));
    vents.visible = vent;
    if (silt) scene.fog.color.lerp(siltFog, Math.min(1, dt * 1.5));
    if (vent) {
      const floor = seabed.position.y + 0.3;
      const p = vents.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) + (1.2 + (i % 5) * 0.3) * dt;
        let x = p.getX(i) + Math.sin(clock * 2 + i) * 0.4 * dt - v.sub.speed * 3.5 * dt;
        if (y > floor + 9 || y < floor) { y = floor + (y < floor ? Math.random() * 9 : 0); x = -14 + (i % 6) * 7 + (Math.random() - 0.5) * 1.2; }
        if (x < -20) x += 42;
        p.setX(i, x); p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    lantern.intensity = lanternBase * (unrest ? 0.8 + 0.2 * Math.abs(Math.sin(clock * 9) * Math.sin(clock * 2.3)) : 1);
  }
  const siltColor = new T.Color(0xc8a070), snowColor = new T.Color(0xcfe2ff), ventGlow = new T.Color(0xff7a30), causticGlow = new T.Color(0x7fb0e0), siltFog = new T.Color(0x4a3a24);

  // ---------------------------------------------------------------- The salon

  // Nemo's salon, built from Verne's description: a long room with a library,
  // an organ, and two great oval windows onto the sea. The sea scene is drawn
  // first, and the salon is drawn over it with holes where the windows are.
  function canvasTexture(w, h, draw, repeat) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }
  function woodTexture() {
    return canvasTexture(512, 512, (g, w, h) => {
      g.fillStyle = "#3b2614"; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 64) {
        const tone = 40 + Math.random() * 20;
        g.fillStyle = `rgb(${tone + 25}, ${tone}, ${tone * 0.55})`; g.fillRect(0, y + 2, w, 60);
        for (let i = 0; i < 26; i++) { g.strokeStyle = `rgba(20, 10, 4, ${0.15 + Math.random() * 0.25})`; g.lineWidth = 1 + Math.random(); g.beginPath(); const yy = y + 4 + Math.random() * 56; g.moveTo(0, yy); for (let x = 0; x <= w; x += 32) g.lineTo(x, yy + Math.sin(x * 0.02 + i) * 3); g.stroke(); }
        g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(0, y, w, 2);
      }
    }, [3, 3]);
  }
  function makeSalon() {
    const S = new T.Scene();
    const wood = new T.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7, metalness: 0.05 });
    const panel = new T.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 0.75, metalness: 0.05 });
    const brass = metal(0xc49a55, 0.35, 1);
    const dark = metal(0x3d2b14, 0.5, 0.8);
    const anchors = {};

    // Room shell. The camera sits at z = 7 looking toward the back wall at z = -6.
    const floor = new T.Mesh(new T.PlaneGeometry(22, 16), wood); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -3, 0); S.add(floor);
    const ceiling = new T.Mesh(new T.PlaneGeometry(22, 16), panel); ceiling.rotation.x = Math.PI / 2; ceiling.position.set(0, 4.2, 0); S.add(ceiling);
    for (const sx of [-1, 1]) { const wall = new T.Mesh(new T.PlaneGeometry(16, 7.2), panel); wall.rotation.y = sx * Math.PI / 2 * -1; wall.position.set(sx * 11, 0.6, 0); S.add(wall); }
    // Back wall with two oval windows.
    const shape = new T.Shape(); shape.moveTo(-11, -3); shape.lineTo(11, -3); shape.lineTo(11, 4.2); shape.lineTo(-11, 4.2); shape.closePath();
    for (const wx of [-4.6, 4.6]) { const hole = new T.Path(); hole.absellipse(wx, 0.5, 2.6, 1.7, 0, Math.PI * 2, false); shape.holes.push(hole); }
    const back = new T.Mesh(new T.ShapeGeometry(shape, 48), panel); back.position.z = -6; S.add(back);
    for (const wx of [-4.6, 4.6]) {
      const frame = new T.Mesh(new T.TorusGeometry(1, 0.09, 10, 64), brass); frame.scale.set(2.65, 1.75, 1); frame.position.set(wx, 0.5, -5.95); S.add(frame);
      for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; const riv = new T.Mesh(new T.SphereGeometry(0.05, 8, 8), metal(0xf0d9a0, 0.25, 1)); riv.position.set(wx + Math.cos(a) * 2.75, 0.5 + Math.sin(a) * 1.85, -5.9); S.add(riv); }
    }
    // Ribs along the ceiling.
    for (let x = -9; x <= 9; x += 3) { const rib = new T.Mesh(new T.BoxGeometry(0.25, 0.25, 16), dark); rib.position.set(x, 4.05, 0); S.add(rib); }

    // The library, left wall. Shelves with books.
    const lib = new T.Group();
    const spines = [0x5a2b1a, 0x2f4a3a, 0x3b3a6a, 0x6a4a1a, 0x4a2a4a, 0x2a3a5a, 0x7a5a2a];
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = -2.2 + shelf * 1.35;
      const board = new T.Mesh(new T.BoxGeometry(0.5, 0.08, 6.5), wood); board.position.set(0, y, 0); lib.add(board);
      let z = -3.1;
      while (z < 3.1) {
        const h = 0.7 + Math.random() * 0.45, w = 0.12 + Math.random() * 0.14;
        const book = new T.Mesh(new T.BoxGeometry(0.42, h, w), new T.MeshStandardMaterial({ color: spines[Math.floor(Math.random() * spines.length)], roughness: 0.8 }));
        book.position.set(0, y + h / 2 + 0.04, z + w / 2); lib.add(book);
        const gilt = new T.Mesh(new T.BoxGeometry(0.02, h * 0.3, w * 0.6), brass); gilt.position.set(0.22, y + h / 2 + 0.04, z + w / 2); lib.add(gilt);
        z += w + 0.015;
      }
    }
    const libFrame = new T.Mesh(new T.BoxGeometry(0.55, 5.6, 6.8), wood); libFrame.position.set(-0.3, 0.4, 0); lib.add(libFrame);
    lib.position.set(-8.6, 0, -2.2); S.add(lib);
    anchors.library = new T.Vector3(-7.9, 1.6, -2.2);

    // The organ, right wall.
    const organ = new T.Group();
    const console_ = new T.Mesh(new T.BoxGeometry(1.6, 1.4, 3.2), wood); console_.position.set(0, -2.3, 0); organ.add(console_);
    const keys = new T.Mesh(new T.BoxGeometry(0.5, 0.08, 2.6), new T.MeshStandardMaterial({ color: 0xe8dfc8, roughness: 0.4 })); keys.position.set(-0.85, -1.62, 0); organ.add(keys);
    for (let i = 0; i < 11; i++) { const hgt = 1.6 + Math.abs(5 - i) * 0.32; const pipe = new T.Mesh(new T.CylinderGeometry(0.11, 0.13, hgt, 12), metal(0xb9c3d6, 0.25, 1)); pipe.position.set(0.2, -1.6 + hgt / 2, -1.5 + i * 0.3); organ.add(pipe); const cap = new T.Mesh(new T.ConeGeometry(0.12, 0.25, 12), brass); cap.position.set(0.2, -1.6 + hgt + 0.12, -1.5 + i * 0.3); organ.add(cap); }
    organ.position.set(8.3, 0, -1.6); S.add(organ);
    anchors.organ = new T.Vector3(7.8, 1.3, -1.6);

    // The chart table, center, under a lamp.
    const table = new T.Group();
    const top = new T.Mesh(new T.BoxGeometry(3.6, 0.12, 2.2), wood); top.position.y = -1.3; table.add(top);
    for (const [x, z] of [[-1.6, -0.9], [1.6, -0.9], [-1.6, 0.9], [1.6, 0.9]]) { const leg = new T.Mesh(new T.CylinderGeometry(0.08, 0.1, 1.7, 8), dark); leg.position.set(x, -2.15, z); table.add(leg); }
    const chart = new T.Mesh(new T.PlaneGeometry(2.6, 1.6), new T.MeshStandardMaterial({ map: chartTexture(), roughness: 0.9 })); chart.rotation.x = -Math.PI / 2; chart.position.set(-0.2, -1.23, 0); table.add(chart);
    const log = new T.Mesh(new T.BoxGeometry(0.7, 0.12, 0.95), new T.MeshStandardMaterial({ color: 0x4a1f1a, roughness: 0.6 })); log.position.set(1.3, -1.18, 0.4); log.rotation.y = -0.25; table.add(log);
    const logClasp = new T.Mesh(new T.BoxGeometry(0.1, 0.14, 0.3), brass); logClasp.position.set(1.62, -1.18, 0.33); logClasp.rotation.y = -0.25; table.add(logClasp);
    const lampArm = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 1.6, 8), brass); lampArm.position.set(0, 3.3, 0); table.add(lampArm);
    const shade = new T.Mesh(new T.ConeGeometry(0.7, 0.5, 24, 1, true), new T.MeshStandardMaterial({ color: 0x2a4a3a, roughness: 0.6, side: T.DoubleSide })); shade.position.set(0, 2.5, 0); table.add(shade);
    const bulb = new T.Mesh(new T.SphereGeometry(0.1, 10, 10), glow(0xffe2b0, 4)); bulb.position.set(0, 2.35, 0); table.add(bulb);
    const lamp = new T.PointLight(0xffd9a0, 40, 14, 1.6); lamp.position.set(0, 2.2, 0); table.add(lamp);
    table.position.set(0, 0, -1); S.add(table);
    anchors.chart = new T.Vector3(-0.6, -1.1, -1);
    anchors.logbook = new T.Vector3(1.4, -1.0, -0.6);

    // Telegraph repeater on a pedestal.
    const ped = new T.Group();
    const column = new T.Mesh(new T.CylinderGeometry(0.22, 0.3, 1.9, 12), dark); column.position.y = -2.05; ped.add(column);
    const dial = new T.Mesh(new T.CylinderGeometry(0.5, 0.5, 0.12, 24), brass); dial.rotation.x = Math.PI / 2 - 0.5; dial.position.y = -1.0; ped.add(dial);
    const face = new T.Mesh(new T.CircleGeometry(0.42, 24), new T.MeshStandardMaterial({ color: 0x0b1224, roughness: 0.5 })); face.rotation.x = -0.5; face.position.set(0, -0.98, 0.07); ped.add(face);
    ped.position.set(3.9, 0, 0.6); S.add(ped);
    anchors.repeater = new T.Vector3(3.9, -0.6, 0.6);

    // A sea chest for the dry dock, and a glass case with a pearl for the articles.
    const chest = makeChestMesh(wood, brass); chest.scale.setScalar(1.6); chest.position.set(5.4, -3, 1.0); S.add(chest);
    anchors.drydock = new T.Vector3(5.4, -1.9, 1.0);
    const caseBase = new T.Mesh(new T.CylinderGeometry(0.45, 0.5, 1.6, 12), dark); caseBase.position.set(-4.8, -2.2, 1.4); S.add(caseBase);
    const glass = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.9, 16), new T.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0, transmission: 0.6 })); glass.position.set(-4.8, -0.95, 1.4); S.add(glass);
    const pearl = new T.Mesh(new T.SphereGeometry(0.18, 16, 16), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, emissive: 0xdde8ff, emissiveIntensity: 0.6 })); pearl.position.set(-4.8, -1.1, 1.4); S.add(pearl);
    anchors.articles = new T.Vector3(-4.8, -0.4, 1.4);
    anchors.sea = new T.Vector3(0, 1.5, -6);

    // Lights.
    S.add(new T.AmbientLight(0x3a4a70, 0.5));
    for (const x of [-7, 7]) { const l = new T.PointLight(0xffd9a0, 18, 12, 1.7); l.position.set(x, 3.0, -3.5); S.add(l); const sconce = new T.Mesh(new T.SphereGeometry(0.07, 10, 10), glow(0xffe2b0, 3)); sconce.position.copy(l.position); S.add(sconce); }
    const seaLight = new T.DirectionalLight(0x6f9fd8, 0.9); seaLight.position.set(0, 2, -5); seaLight.target.position.set(0, -1, 4); S.add(seaLight, seaLight.target);
    const cam = new T.PerspectiveCamera(56, 16 / 9, 0.1, 60);
    cam.position.set(0, 0.2, 9);
    return { scene: S, camera: cam, anchors, screen: {} };
  }
  function makeChestMesh(wood, brass) {
    const grp = new T.Group();
    const box = new T.Mesh(new T.BoxGeometry(1.1, 0.55, 0.7), wood); box.position.y = 0.28;
    const lid = new T.Mesh(new T.CylinderGeometry(0.36, 0.36, 1.1, 12, 1, false, 0, Math.PI), wood); lid.rotation.z = Math.PI / 2; lid.rotation.y = Math.PI; lid.position.set(0, 0.56, 0);
    for (const x of [-0.35, 0.35]) { const band = new T.Mesh(new T.BoxGeometry(0.1, 0.95, 0.74), brass); band.position.set(x, 0.47, 0); grp.add(band); }
    grp.add(box, lid);
    return grp;
  }
  function chartTexture() {
    return canvasTexture(512, 320, (g, w, h) => {
      g.fillStyle = "#d9c7a0"; g.fillRect(0, 0, w, h);
      g.strokeStyle = "rgba(90, 60, 30, 0.35)"; g.lineWidth = 1;
      for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      g.strokeStyle = "#5a3a1a"; g.lineWidth = 2.5; g.beginPath(); g.moveTo(40, 250); g.bezierCurveTo(140, 120, 260, 280, 360, 150); g.bezierCurveTo(400, 100, 440, 120, 470, 70); g.stroke();
      g.fillStyle = "#5a3a1a"; for (const [x, y] of [[40, 250], [200, 200], [360, 150], [470, 70]]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
      g.font = "italic 18px Georgia"; g.fillText("Free Harbor", 50, 240); g.fillText("The Ice", 380, 60);
      g.strokeStyle = "rgba(90,60,30,0.6)"; g.lineWidth = 3; g.strokeRect(6, 6, w - 12, h - 12);
    });
  }
  function renderSalon(dt) {
    if (!salon) salon = makeSalon();
    const cam = salon.camera;
    cam.aspect = cw / ch;
    // Narrow screens see the whole room by standing further back.
    cam.position.z = 9 + Math.max(0, (1.6 - cam.aspect)) * 6;
    cam.updateProjectionMatrix();
    cam.position.x = Math.sin(clock * 0.12) * 0.35;
    cam.position.y = 0.2 + Math.sin(clock * 0.09) * 0.12;
    cam.lookAt(0, -0.2, -6);
    // The sea through the windows.
    renderer.autoClear = true;
    composer.render(dt);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(salon.scene, cam);
    renderer.autoClear = true;
    // Tags are placed from a still camera, so they do not drift with the sway.
    const still = cam.clone();
    still.position.set(0, 0.2, cam.position.z); still.lookAt(0, -0.2, -6); still.updateMatrixWorld();
    for (const [id, v3] of Object.entries(salon.anchors)) {
      const p = v3.clone().project(still);
      salon.screen[id] = { x: Math.round((p.x + 1) / 2 * cw), y: Math.round((1 - p.y) / 2 * ch), visible: p.z < 1 };
    }
  }
  function anchors() { return salon ? salon.screen : null; }

  function begin() { intro = 1; }
  return { name: "3d", init, resize, project, unproject, event, render, anchors, settle: tickEffects, begin };
}
