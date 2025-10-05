document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = 'http://127.0.0.1:5000';
    const EARTH_RADIUS = 50; // Earth radius in Three.js units
    const SATELLITE_ALTITUDE = 5; // Satellite altitude above Earth surface

    // --- STATE MANAGEMENT ---
    let state = {
        isPlaying: true,
        speedMultiplier: 100,
        direction: 1,
        elapsedSeconds: 0,
        lastTimestamp: performance.now(),
        isPopulationMapActive: false,
        lastData: null
    };

    // --- DOM ELEMENTS ---
    const canvas = document.getElementById('globe-canvas');
    const populationTooltip = document.getElementById('population-tooltip');
    const togglePopulationBtn = document.getElementById('toggle-population-btn');
    const calculateScoreBtn = document.getElementById('calculate-score-btn');
    const scoreDisplay = document.getElementById('score-display');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const reverseBtn = document.getElementById('reverse-btn');
    const forwardBtn = document.getElementById('forward-btn');
    const speedSlider = document.getElementById('speed-slider');
    const speedLabel = document.getElementById('speed-label');
    const timeDisplay = document.getElementById('time-display');
    const utcTimeDisplay = document.getElementById('utc-time-display');

    // --- THREE.JS SETUP ---
    let scene, camera, renderer, earth, satellite, controls;
    let trailPoints = [];
    let spotbeamLine = null;
    let populationEarthTexture = null; // Cache for the population map
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Initialize Three.js scene
    function initThreeJS() {
        // Scene setup
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000022);
        scene.fog = new THREE.Fog(0x000022, 100, 200);

        // Camera setup
        camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
        camera.position.z = 120;

        // Renderer setup
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);

        // Add a soft ambient light for the scene
        const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
        scene.add(ambientLight);

        // --- EARTH SHADER MATERIAL ---
        const earthGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);
        const textureLoader = new THREE.TextureLoader();
        
        // Use a placeholder for the population texture until it's loaded by the user
        const placeholderTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);

        const earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                dayTexture: { value: textureLoader.load(`${API_BASE_URL}/static/textures/8k_earth_daymap.jpg`) },
                nightTexture: { value: textureLoader.load(`${API_BASE_URL}/static/textures/8k_earth_nightmap.jpg`) },
                populationTexture: { value: placeholderTexture },
                sunDirection: { value: new THREE.Vector3(1, 0, 0).normalize() },
                uShowPopulation: { value: false }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vNormal;
                void main() {
                    vUv = uv;
                    vNormal = normalize(normalMatrix * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D dayTexture;
                uniform sampler2D nightTexture;
                uniform sampler2D populationTexture;
                uniform vec3 sunDirection;
                uniform bool uShowPopulation;
                varying vec2 vUv;
                varying vec3 vNormal;
                void main() {
                    // 1. Calculate lighting intensity
                    float intensity = pow(max(dot(vNormal, sunDirection), 0.0), 1.2);
                    // 2. Get base day/night colors
                    vec4 dayColor = texture2D(dayTexture, vUv);
                    vec4 nightColor = texture2D(nightTexture, vUv);
                    nightColor.rgb *= (0.15 + texture2D(nightTexture, vUv).r * 0.7);
                    // 3. Mix day and night
                    vec4 finalColor = mix(nightColor, dayColor, intensity);
                    // 4. Overlay population map if active
                    if (uShowPopulation) {
                        vec4 popColor = texture2D(populationTexture, vUv);
                        if (popColor.a > 0.05) {
                            finalColor = mix(finalColor, popColor, popColor.a * 0.9);
                        }
                    }
                    gl_FragColor = vec4(finalColor.rgb, 1.0);
                }
            `
        });
        earth = new THREE.Mesh(earthGeometry, earthMaterial);
        scene.add(earth);

        // --- ATMOSPHERE SHADER ---
        const atmosphereGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 1.02, 64, 64);
        const atmosphereMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec3 vNormal;
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec3 vNormal;
                void main() {
                    float intensity = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
                    gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity * 0.5;
                }
            `,
            blending: THREE.AdditiveBlending,
            side: THREE.BackSide
        });
        const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
        scene.add(atmosphere);

        // --- STARS ---
        const starGeometry = new THREE.BufferGeometry();
        const starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, sizeAttenuation: true });
        const starVertices = [];
        for (let i = 0; i < 10000; i++) {
            const x = (Math.random() - 0.5) * 2000;
            const y = (Math.random() - 0.5) * 2000;
            const z = (Math.random() - 0.5) * 2000;
            starVertices.push(x, y, z);
        }
        starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
        const stars = new THREE.Points(starGeometry, starMaterial);
        scene.add(stars);

        // --- CONTROLS & LISTENERS ---
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;

        canvas.addEventListener('mousemove', handleCanvasMouseMove);
        canvas.addEventListener('click', handleCanvasClick);
    }

    // Convert lat/lon to 3D position
    function latLonToVector3(lat, lon, radius) {
        const phi = (90 - lat) * Math.PI / 180;
        const theta = (lon + 180) * Math.PI / 180;
        return new THREE.Vector3(
            -radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.sin(theta)
        );
    }

    // Update satellite position
    function updateSatellitePosition(lat, lon) {
        if (!satellite) {
            const satelliteGeometry = new THREE.SphereGeometry(1.5, 16, 16);
            const satelliteMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
            satellite = new THREE.Mesh(satelliteGeometry, satelliteMaterial);
            scene.add(satellite);
        }
        const position = latLonToVector3(lat, lon, EARTH_RADIUS + SATELLITE_ALTITUDE);
        satellite.position.copy(position);

        trailPoints.push(position.clone());
        if (trailPoints.length > 1000) trailPoints.shift();
    }

    // Update spotbeam visualization
    function updateSpotbeam(polygon) {
        if (spotbeamLine) {
            scene.remove(spotbeamLine);
            spotbeamLine.geometry.dispose();
            spotbeamLine.material.dispose();
        }
        const points = polygon.map(p => latLonToVector3(p[1], p[0], EARTH_RADIUS + 0.2));
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.8 });
        spotbeamLine = new THREE.LineLoop(geometry, material);
        scene.add(spotbeamLine);
    }

    // Update ground track trail
    function updateGroundTrack() {
        const oldTrail = scene.getObjectByName('groundTrack');
        if (oldTrail) {
            scene.remove(oldTrail);
            oldTrail.geometry.dispose();
            oldTrail.material.dispose();
        }
        if (trailPoints.length < 2) return;
        const trailGeometry = new THREE.BufferGeometry().setFromPoints(trailPoints);
        const trailMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
        const trail = new THREE.Line(trailGeometry, trailMaterial);
        trail.name = 'groundTrack';
        scene.add(trail);
    }

    function getIntersectionLatLon(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(earth);
        if (intersects.length > 0) {
            const p = intersects[0].point;
            const lat = 90 - (Math.acos(p.y / p.length()) * 180 / Math.PI);
            const lon = -((Math.atan2(p.z, p.x)) * 180 / Math.PI);
            return { lat, lon };
        }
        return null;
    }

    function handleCanvasMouseMove(event) {
        if (!state.isPopulationMapActive) {
            populationTooltip.style.display = 'none';
            return;
        }
        const coords = getIntersectionLatLon(event);
        if (coords) {
            populationTooltip.style.left = `${event.clientX}px`;
            populationTooltip.style.top = `${event.clientY}px`;
            populationTooltip.style.display = 'block';
            populationTooltip.innerHTML = `Lat: ${coords.lat.toFixed(2)}, Lon: ${coords.lon.toFixed(2)}<br>Calculating...`;
            clearTimeout(window.populationDebounce);
            window.populationDebounce = setTimeout(() => fetchPopulationEstimate(coords.lat, coords.lon), 200);
        } else {
            populationTooltip.style.display = 'none';
        }
    }

    function handleCanvasClick(event) {
        if (!state.isPopulationMapActive) return;
        const coords = getIntersectionLatLon(event);
        if (coords) {
            populationTooltip.innerHTML = `Lat: ${coords.lat.toFixed(2)}, Lon: ${coords.lon.toFixed(2)}<br>Fetching...`;
            fetchPopulationEstimate(coords.lat, coords.lon);
        }
    }

    function updateVisualization(data) {
        if (!data) return;
        updateSatellitePosition(data.latitude, data.longitude);
        updateSpotbeam(data.spotbeam_polygon);
        updateGroundTrack();
        
        // Update Earth rotation based on elapsed time
        // Earth completes one rotation every 86400 seconds (24 hours)
        if (earth) {
            const rotationsPerSecond = 1 / 86400; // One full rotation per day
            const totalRotations = data.elapsed_seconds * rotationsPerSecond;
            earth.rotation.y = totalRotations * Math.PI * 2; // Convert rotations to radians
        }
        
        const days = Math.floor(data.elapsed_seconds / 86400);
        const remainingSeconds = data.elapsed_seconds % 86400;
        const time = new Date(remainingSeconds * 1000).toISOString().substr(11, 8);
        timeDisplay.textContent = `Day ${String(days).padStart(2, '0')} / Hour ${time}`;
        utcTimeDisplay.textContent = `UTC: ${new Date(data.simulation_time_iso).toUTCString()}`;
        state.lastData = data;
    }

    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }

    function handleResize() {
        camera.aspect = canvas.clientWidth / canvas.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    }

    // --- API FUNCTIONS ---
    async function fetchData(elapsedSeconds) {
        try {
            const response = await fetch(`${API_BASE_URL}/api/position?elapsed_seconds=${elapsedSeconds}&radius_km=1300`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error("Could not fetch satellite data:", error);
            state.isPlaying = false;
            updatePlayPauseButton();
            return null;
        }
    }

    async function togglePopulationMap() {
        const isActive = togglePopulationBtn.classList.contains('active');
        if (isActive) {
            togglePopulationBtn.classList.remove('active');
            state.isPopulationMapActive = false;
            populationTooltip.style.display = 'none';
            if (earth) earth.material.uniforms.uShowPopulation.value = false;
        } else {
            togglePopulationBtn.textContent = 'Loading...';
            togglePopulationBtn.disabled = true;
            try {
                // If texture is already loaded, just flip the boolean and reuse it
                if (populationEarthTexture) {
                    earth.material.uniforms.uShowPopulation.value = true;
                } else {
                    // Otherwise, fetch the map URL and load the texture for the first time
                    const response = await fetch(`${API_BASE_URL}/api/population-density`);
                    if (!response.ok) throw new Error('Failed to get population map URL');
                    const data = await response.json();
                    const mapUrl = `${API_BASE_URL}${data.map_url}`;
                    // Use await to ensure the texture is loaded before we assign it
                    populationEarthTexture = await new THREE.TextureLoader().loadAsync(mapUrl);
                    earth.material.uniforms.populationTexture.value = populationEarthTexture;
                    earth.material.uniforms.uShowPopulation.value = true;
                }
                togglePopulationBtn.classList.add('active');
                state.isPopulationMapActive = true;
            } catch (error) {
                console.error("Error toggling population map:", error);
                alert("Could not load the population density map.");
            } finally {
                togglePopulationBtn.textContent = 'Population Density';
                togglePopulationBtn.disabled = false;
            }
        }
    }

    async function calculateCoverageScore() {
        calculateScoreBtn.disabled = true;
        calculateScoreBtn.textContent = 'Calculating...';
        scoreDisplay.textContent = '';
        try {
            const response = await fetch(`${API_BASE_URL}/api/coverage-score`);
            if (!response.ok) throw new Error((await response.json()).error || 'Calculation failed');
            const data = await response.json();
            scoreDisplay.textContent = `Score: ~${data.coverage_score.toLocaleString()} people`;
        } catch (error) {
            console.error("Error calculating coverage score:", error);
            scoreDisplay.textContent = 'Error calculating score.';
        } finally {
            calculateScoreBtn.disabled = false;
            calculateScoreBtn.textContent = 'Calculate Coverage Score';
        }
    }

    async function fetchPopulationEstimate(lat, lon) {
        try {
            if (isNaN(lat) || isNaN(lon)) return;
            const response = await fetch(`${API_BASE_URL}/api/population-estimate?lat=${lat}&lon=${lon}&radius_km=1`);
            const data = await response.json();
            populationTooltip.innerHTML = `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}<br>Pop. (~1km): ${data.estimated_population.toLocaleString()}`;
        } catch (error) {
            console.error("Error fetching population estimate:", error);
            populationTooltip.innerHTML = `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}<br>Could not load data.`;
        }
    }

    async function simulationLoop(timestamp) {
        const deltaTime = (timestamp - state.lastTimestamp) / 1000;
        state.lastTimestamp = timestamp;
        if (state.isPlaying) {
            state.elapsedSeconds += deltaTime * state.speedMultiplier * state.direction;
            const data = await fetchData(state.elapsedSeconds);
            updateVisualization(data);
        }
        requestAnimationFrame(simulationLoop);
    }

    function updatePlayPauseButton() {
        playPauseBtn.textContent = state.isPlaying ? '⏸️' : '▶️';
    }

    // Initialize and start
    initThreeJS();
    animate();
    simulationLoop(performance.now());

    // Event listeners
    playPauseBtn.addEventListener('click', () => {
        state.isPlaying = !state.isPlaying;
        updatePlayPauseButton();
    });
    calculateScoreBtn.addEventListener('click', calculateCoverageScore);
    reverseBtn.addEventListener('click', () => { state.direction = -1; });
    forwardBtn.addEventListener('click', () => { state.direction = 1; });
    speedSlider.addEventListener('input', (e) => {
        state.speedMultiplier = Number(e.target.value);
        speedLabel.textContent = `${state.speedMultiplier}x`;
    });
    window.addEventListener('resize', handleResize);
    togglePopulationBtn.addEventListener('click', togglePopulationMap);

    // Initial setup
    updatePlayPauseButton();
    speedLabel.textContent = `${state.speedMultiplier}x`;
});