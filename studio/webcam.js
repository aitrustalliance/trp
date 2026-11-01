/**
 * Webcam distance sensor (experimental).
 *
 * Estimates how far a person is from the camera from the width between their
 * shoulders in a pose model's normalized landmarks, after a one-step
 * calibration at a known distance. Distance is roughly inversely
 * proportional to apparent shoulder width.
 *
 * The pose model is MediaPipe Pose Landmarker from @mediapipe/tasks-vision,
 * loaded on demand. The URLs and landmark indices below must be checked
 * before release. See studio/DATA_SOURCES.md.
 */
(function (root) {
  "use strict";

  const CONFIG = {
    // TO VERIFY: pin an exact version, or vendor the package into studio/vendor/.
    bundle: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs",
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
    // TO VERIFY: model file location from the MediaPipe Pose Landmarker guide.
    model: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    // TO VERIFY: left and right shoulder in the 33-point pose layout.
    leftShoulder: 11,
    rightShoulder: 12,
  };

  // Pure functions, tested in Node.
  function shoulderWidth(landmarks) {
    const a = landmarks && landmarks[CONFIG.leftShoulder];
    const b = landmarks && landmarks[CONFIG.rightShoulder];
    if (!a || !b) return null;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function calibrate(width, knownDistance) { return width * knownDistance; }
  function distanceFrom(width, k) {
    if (!width || !k) return null;
    return Math.max(0, Math.min(6, k / width));
  }

  async function start(video, onWidth, onStatus) {
    const say = onStatus || function () {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser has no camera access.");
    say("Asking for camera permission.");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();
    say("Loading the pose model.");
    const vision = await import(CONFIG.bundle);
    const fileset = await vision.FilesetResolver.forVisionTasks(CONFIG.wasm);
    const landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CONFIG.model },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    say("Tracking.");
    let running = true;
    let last = -1;
    function loop() {
      if (!running) return;
      if (video.currentTime !== last) {
        last = video.currentTime;
        const result = landmarker.detectForVideo(video, performance.now());
        const lm = result && result.landmarks && result.landmarks[0];
        onWidth(lm ? shoulderWidth(lm) : null);
      }
      requestAnimationFrame(loop);
    }
    loop();
    return function stop() {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      if (landmarker.close) landmarker.close();
    };
  }

  const api = { CONFIG, shoulderWidth, calibrate, distanceFrom, start };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPWebcam = api;
})(typeof window !== "undefined" ? window : globalThis);
