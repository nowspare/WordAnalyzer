/* ============================================================
   Three.js background — particles + floating wireframe shapes
   Lightweight, paused when hidden, adaptive density.
   ============================================================ */
(function(){
  'use strict';

  const CFG = {
    low:    { particles: 420,  shapes: 2 },
    medium: { particles: 900,  shapes: 3 },
    high:   { particles: 1600, shapes: 4 }
  };

  let renderer, scene, camera, points, group;
  let running = false;
  let density = 'medium';
  let reducedMotion = false;
  let initialized = false;
  const clock = { last: 0 };

  function available(){
    return typeof THREE !== 'undefined';
  }

  function init(){
    if (!available() || initialized) return;
    const canvas = document.getElementById('bg3d');
    if (!canvas) return;

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: 'low-power'
      });
    } catch(e){
      console.warn('[three] WebGL unavailable', e);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060d, 0.055);

    camera = new THREE.PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.1, 120
    );
    camera.position.set(0, 0, 16);

    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    density = (window.UA && UA.Prefs.get('particles', 'medium')) || 'medium';
    if (!CFG[density]) density = 'medium';

    buildParticles();
    buildShapes();
    resize();

    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    initialized = true;
    if (reducedMotion) {
      renderOnce();
    } else {
      start();
    }
    if (window.UA) UA.AppLog('[three] scene ready · density=' + density);
  }

  function buildParticles(){
    if (points){
      scene.remove(points);
      points.geometry.dispose();
      points.material.dispose();
      points = null;
    }
    const count = CFG[density].particles;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    const palette = [
      new THREE.Color(0x4da3ff),
      new THREE.Color(0x4ff0e0),
      new THREE.Color(0xa86bff)
    ];

    for (let i = 0; i < count; i++){
      // spherical shell
      const r = 7 + Math.random() * 16;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i*3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i*3 + 1] = r * Math.cos(phi) * 0.65;
      positions[i*3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 6;

      const c = palette[(Math.random() * palette.length) | 0];
      colors[i*3]     = c.r;
      colors[i*3 + 1] = c.g;
      colors[i*3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.085,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    });

    points = new THREE.Points(geo, mat);
    scene.add(points);
  }

  function buildShapes(){
    if (group){
      scene.remove(group);
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      group = null;
    }
    group = new THREE.Group();
    const n = CFG[density].shapes;

    for (let i = 0; i < n; i++){
      const isTorus = i % 2 === 1;
      const geo = isTorus
        ? new THREE.TorusGeometry(1.5 + Math.random(), 0.02, 8, 60)
        : new THREE.IcosahedronGeometry(1.4 + Math.random() * 1.1, 0);

      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xa86bff : 0x4da3ff,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 9,
        -4 - Math.random() * 12
      );
      mesh.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
      mesh.userData = {
        rx: (Math.random() - 0.5) * 0.0025,
        ry: (Math.random() - 0.5) * 0.0035,
        floatAmp: 0.15 + Math.random() * 0.25,
        floatSpeed: 0.0003 + Math.random() * 0.0005,
        phase: Math.random() * Math.PI * 2,
        baseY: mesh.position.y
      };
      group.add(mesh);
    }
    scene.add(group);
  }

  function resize(){
    if (!renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (reducedMotion) renderOnce();
  }

  function onVisibility(){
    if (document.hidden) pause();
    else if (!reducedMotion) resume();
  }

  function step(t){
    if (!running) return;
    const dt = t - (clock.last || t);
    clock.last = t;

    if (points){
      points.rotation.y += 0.000045 * dt;
      points.rotation.x += 0.000012 * dt;
    }
    if (group){
      const time = t;
      group.children.forEach(m => {
        const u = m.userData;
        m.rotation.x += u.rx * dt;
        m.rotation.y += u.ry * dt;
        m.position.y = u.baseY + Math.sin(time * u.floatSpeed * 1.2 + u.phase) * u.floatAmp;
      });
    }
    renderer.render(scene, camera);
    requestAnimationFrame(step);
  }

  function start(){
    if (!renderer || reducedMotion) return;
    running = true;
    clock.last = 0;
    requestAnimationFrame(step);
  }
  function pause(){ running = false; }
  function resume(){ if (initialized && !running) start(); }

  function renderOnce(){
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function setDensity(d){
    if (!CFG[d] || d === density) return;
    density = d;
    if (window.UA) UA.Prefs.set('particles', d);
    if (!initialized) return;
    buildParticles();
    buildShapes();
    if (reducedMotion) renderOnce();
    if (window.UA) UA.AppLog('[three] density set to ' + d);
  }

  window.ThreeScene = { init, pause, resume, setDensity };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
