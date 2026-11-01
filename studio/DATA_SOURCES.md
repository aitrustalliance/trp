# TRP Studio Data Sources

TRP Studio runs on simulated data by default. The Lab page (`studio/lab.html`) adds two experimental live inputs. Both were written against published documentation, but neither could be reached from the build environment, so each needs a short check in a real browser before release. This guide lists what was verified, what was not, and the exact steps to finish each one.

## Status

| Input | Code | Verified | Still To Check |
|---|---|---|---|
| LeRobot episode replay | `studio/lerobot.js` | API shape and dataset features, from the Hugging Face documentation and dataset page. Parsing tested in `tests/lerobot_parse.js` | Browser access (CORS), rate limits, and whether datasets with video columns return rows |
| Webcam distance sensor | `studio/webcam.js` | Library name and setup calls, from the MediaPipe Pose Landmarker web guide. Distance math tested in `tests/lerobot_parse.js` | Model file URL, shoulder landmark indices, pinned library version |

## LeRobot Episode Replay

**What it does.** The Lab fetches one episode of a public LeRobot arm dataset through the Hugging Face dataset viewer API and evaluates every frame against `examples/arm-motion/trp.json`.

**Verified facts.**

- Endpoint: `GET https://datasets-server.huggingface.co/rows?dataset=<id>&config=default&split=train&offset=<n>&length=<up to 100>`. Public datasets need no token. The response has `features`, `rows[].row` and `num_rows_total`.
- The example dataset `sehajp/so101_pick_place` is LeRobot v3.0, recorded at 30 frames per second, Apache 2.0. `observation.state` and `action` are six numbers each, in the order shoulder pan, shoulder lift, elbow flex, wrist flex, wrist roll and gripper. Each row also carries `timestamp`, `frame_index` and `episode_index`.

**Steps to finish (about 30 minutes).**

1. Serve the repository with `python3 -m http.server 8000` and open `http://localhost:8000/studio/lab.html`.
2. Press Load and replay. If the status line reports frame counts, browser access works and this step is done.
3. If the console shows a CORS error, add a small proxy. The simplest is a serverless function that forwards `/rows` requests to `datasets-server.huggingface.co` and adds `Access-Control-Allow-Origin`. Set its address as `API` in `studio/lerobot.js`. Cache responses, because each episode is several requests.
4. If the API returns an error for this dataset, open `https://datasets-server.huggingface.co/rows?dataset=sehajp/so101_pick_place&config=default&split=train&offset=0&length=5` in a browser tab and read the message. If the viewer refuses the dataset, pick another LeRobot SO-100 or SO-101 dataset whose Hugging Face page shows the Dataset Viewer, and change the default in `studio/lab.html`.
5. Look at the reported peak joint speed and tracking error, then set the thresholds in `examples/arm-motion/trp.json` to match the dataset's units. The current values are placeholders.
6. Run `node tests/lerobot_parse.js` and `python3 tests/run_conformance.py`.

**Fallback.** For a demo that cannot depend on the network, download one episode once with the same URL, save it as `studio/packs/lerobot/episode.json` in the `/rows` response format, and point `fetchEpisode` at it.

## Webcam Distance Sensor

**What it does.** The Lab asks for the camera, runs a pose model in the browser, and estimates the person's distance from the width between their shoulders after one calibration at 1.5 m. The distance feeds the robot cell profile. Video never leaves the browser.

**Verified facts.** The library is `@mediapipe/tasks-vision` on npm. The web guide loads the runtime with `FilesetResolver.forVisionTasks(<wasm folder>)`, creates the model with `PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath }, runningMode: "VIDEO" })`, and calls `detectForVideo(video, timestamp)` on each frame.

**Not yet verified.** The three values marked `TO VERIFY` in `studio/webcam.js`, which are the model file URL, the left and right shoulder indices (11 and 12), and the library version (currently `latest`, which should be pinned).

**Steps to finish (about 30 minutes).**

1. Open the MediaPipe Pose Landmarker guide for web, copy the current model file URL and the pose landmark diagram, and update `CONFIG` in `studio/webcam.js`.
2. Pin the library to the exact current version in both `bundle` and `wasm`. For an offline demo, run `npm pack @mediapipe/tasks-vision`, copy `vision_bundle.mjs` and the `wasm` folder into `studio/vendor/`, download the model file to the same folder, and point `CONFIG` at those local paths.
3. Serve over `localhost` or HTTPS, since browsers only allow camera access there. Open the Lab, press Start camera, stand 1.5 m away, press calibrate, and walk toward the camera. The standing should move to Failing inside the exclusion distance.
4. If tracking is jumpy, average the last five widths before computing distance.

## Privacy

Neither input sends anything to a TRP server, and there is no TRP server. The LeRobot replay contacts Hugging Face directly. The webcam input downloads the pose model and processes video on the device. Any future feature that stores results, such as a leaderboard, needs an opt-in, a privacy notice, and server-side replay checking before scores are accepted.
