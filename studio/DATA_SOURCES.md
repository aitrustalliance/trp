# TRP Studio Data Sources

TRP Studio runs on simulated data by default, and the Connect mode accepts outside evidence as described in [CONNECT.md](CONNECT.md). The Lab page (`studio/lab.html`) adds two experimental live inputs. Both were written against published documentation, but neither could be reached from the build environment, so each needs a short check in a real browser before release. This guide lists what was verified, what was not, and the exact steps to finish each one.

## Status

| Input | Code | Verified | Still To Check |
|---|---|---|---|
| LeRobot episode replay | `studio/lerobot.js` | Endpoint, parameters, 100-row page limit and response fields (`features`, `rows[].row`, `num_rows_total`) against the Hugging Face dataset viewer quick start, 2026-11-01. Parsing tested in `tests/lerobot_parse.js` | Browser access (CORS), rate limits, and whether the viewer serves `sehajp/so101_pick_place`. The docs do not cover CORS or rate limits, and the build environment cannot reach the API |
| Webcam distance sensor | `studio/webcam.js` | Library pinned to `@mediapipe/tasks-vision` 1.2.0 (npm latest, 2026-11-01), with the bundle, wasm folder and API signatures confirmed in the package. Model URL and shoulder indices 11 and 12 from the Pose Landmarker guide, 2026-11-01. Distance math tested in `tests/lerobot_parse.js` | Camera permission, model download and tracking in a real browser. The build environment has no camera and cannot reach the model host |

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

**Fallback.** When the API cannot be reached, the Lab and the Studio replay a synthetic SO-101 episode from `TRPLeRobot.synthEpisode`, labeled as synthetic. For a demo on real data with no network, download one episode once with the same URL from a normal browser and replay it through the Studio's Connect, File source.

## Webcam Distance Sensor

**What it does.** The Lab asks for the camera, runs a pose model in the browser, and estimates the person's distance from the width between their shoulders after one calibration at 1.5 m. The distance feeds the robot cell profile. Video never leaves the browser.

**Verified facts.** The library is `@mediapipe/tasks-vision` on npm. The web guide loads the runtime with `FilesetResolver.forVisionTasks(<wasm folder>)`, creates the model with `PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath }, runningMode: "VIDEO" })`, and calls `detectForVideo(video, timestamp)` on each frame.

**Configuration, verified 2026-11-01.** `CONFIG` in `studio/webcam.js` pins version 1.2.0, uses the model URL from the guide, and reads landmarks 11 and 12. The guide's model URL ends in `latest`, so the model can change under a pinned library. For an offline or frozen demo, download the model once and serve it locally.

**Steps to finish.**

1. For an offline demo, run `npm pack @mediapipe/tasks-vision@1.2.0`, copy `vision_bundle.mjs` and the `wasm` folder into `studio/vendor/`, download the model file to the same folder, and point `CONFIG` at those local paths. The wasm files total about 42 MB, so keep them out of the repository and serve them from the host.
2. Serve over `localhost` or HTTPS, since browsers only allow camera access there. Open the Lab, press Start camera, stand 1.5 m away, press calibrate, and walk toward the camera. The standing should move to Failing inside the exclusion distance.
3. If tracking is jumpy, average the last five widths before computing distance.

## Privacy

Neither input sends anything to a TRP server, and there is no TRP server. The LeRobot replay contacts Hugging Face directly. The webcam input downloads the pose model and processes video on the device. Any future feature that stores results, such as a leaderboard, needs an opt-in, a privacy notice, and server-side replay checking before scores are accepted.
