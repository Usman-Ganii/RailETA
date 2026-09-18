let trainData = [];
let map = null;
let trainMarker = null;
let routeLayer = null;
let activeRouteLayer = null;
let stationLayer = null;
let animationFrame = null;
let firstMapRender = true;

// ==========================================
// DYNAMIC PREDICTION TRACKING STATE
// ==========================================

let previousPrediction = null;
let predictionTrackingCount = 0;
let predictionTrendData = [];
let predictionTrendChart = null;

let livePredictionRefreshTimer = null;
let activeLiveTrainNumber = null;

document.addEventListener("DOMContentLoaded", () => {
    loadTrainData();
    loadHistory();
    loadDashboardStats();
    loadFeatureImportance();
    loadModelPerformance();

    const predictionForm = document.getElementById("predictionForm");
    if (predictionForm) {
        predictionForm.addEventListener("submit", handleManualPrediction);
    }

    const trainSelect = document.getElementById("train_name");
    if (trainSelect) {
        trainSelect.addEventListener("change", handleTrainSelection);
    }

    const livePredictBtn = document.getElementById("livePredictBtn");
    if (livePredictBtn) {
        livePredictBtn.addEventListener("click", handleLivePrediction);
    }

    initializeMap();
});

async function loadTrainData() {
    const select = document.getElementById("train_name");

    if (!select) {
        return;
    }

    try {
        const response = await fetch("/trains");
        const text = await response.text();

        let data;

        try {
            data = JSON.parse(text);
        } catch {
            throw new Error("Server returned an invalid response.");
        }

        if (!response.ok) {
            throw new Error(data.error || "Failed to load trains.");
        }

        trainData = Array.isArray(data.trains) ? data.trains : data;

        select.innerHTML = '<option value="">Select a train</option>';

        trainData.forEach(train => {
            const option = document.createElement("option");

            option.value = train.number || train.train_number || "";
            option.textContent =
                `${train.number || train.train_number || ""} - ${train.name || train.train_name || "Unknown Train"}`;

            select.appendChild(option);
        });
    } catch (error) {
        console.error("Train loading error:", error);
        select.innerHTML = '<option value="">Unable to load trains</option>';
    }
}

function handleTrainSelection() {
    const select = document.getElementById("train_name");
    const selectedNumber = select.value;

    const train = trainData.find(item =>
        String(item.number || item.train_number) === String(selectedNumber)
    );

    if (!train) {
        return;
    }

    setValue("current_delay", train.current_delay ?? train.delay ?? 0);
    setValue("distance_remaining", train.distance_remaining ?? train.distance ?? 0);
    setValue("stops_remaining", train.stops_remaining ?? 0);
    setValue("historical_avg_delay", train.historical_avg_delay ?? train.avg_delay ?? 0);
}

async function handleManualPrediction(event) {
    event.preventDefault();

    const statusBadge = document.getElementById("statusBadge");

    setStatus(statusBadge, "Predicting...", "loading");

    const payload = {
        train_name: getValue("train_name"),
        current_delay: getNumber("current_delay"),
        distance_remaining: getNumber("distance_remaining"),
        stops_remaining: getNumber("stops_remaining"),
        historical_avg_delay: getNumber("historical_avg_delay"),
        scheduled_arrival: getValue("scheduled_arrival")
    };

    try {
        const response = await fetch("/predict", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();

        let data;

        try {
            data = JSON.parse(text);
        } catch {
            console.error("Server response:", text);
            throw new Error("Server returned an invalid response.");
        }

        if (!response.ok || data.success === false) {
            throw new Error(data.error || "Prediction failed.");
        }

        displayManualPrediction(data);

        setStatus(statusBadge, "Success", "success");
    } catch (error) {
        console.error("Prediction error:", error);

        setStatus(statusBadge, "Error", "error");

        const result = document.getElementById("predictedEta");
        if (result) {
            result.textContent = error.message;
        }

        setValue("currentDelayResult", "--");
        setValue("additionalDelayResult", "--");
        setValue("totalDelayResult", "--");
    }
}

function displayManualPrediction(data) {
    const prediction = data.prediction || data;

    const trainName =
        data.train_name ||
        data.train?.name ||
        getValue("train_name") ||
        "Train";

    const predictedAdditionalDelay =
        prediction.additional_delay ??
        prediction.predicted_additional_delay ??
        data.predicted_additional_delay ??
        0;

    const totalDelay =
        prediction.total_delay ??
        data.total_delay ??
        0;

    const predictedEta =
        prediction.predicted_eta ??
        prediction.eta ??
        data.predicted_eta ??
        data.eta ??
        null;

    setText("resultTrain", trainName);

    setText(
        "predictedEta",
        predictedEta ? formatDateTime(predictedEta) : "ETA unavailable"
    );

    setText(
        "etaDate",
        predictedEta ? formatDateTime(predictedEta) : "--"
    );

    setText(
        "currentDelayResult",
        `${formatNumber(getNumber("current_delay"))} min`
    );

    setText(
        "additionalDelayResult",
        `${formatNumber(predictedAdditionalDelay)} min`
    );

    setText(
        "totalDelayResult",
        `${formatNumber(totalDelay)} min`
    );

    updatePredictionFactors(
        getNumber("current_delay"),
        getNumber("distance_remaining"),
        getNumber("stops_remaining"),
        getNumber("historical_avg_delay")
    );
}

function updatePredictionFactors(currentDelay, distance, stops, historicalDelay) {
    setText("factorCurrentDelay", `${formatNumber(currentDelay)} min`);
    setText("factorDistance", `${formatNumber(distance)} km`);
    setText("factorStops", `${formatNumber(stops)} stops`);
    setText("factorHistorical", `${formatNumber(historicalDelay)} min`);
}

async function handleLivePrediction() {
    const input = document.getElementById("liveTrainNumber");
    const trainNumber = input ? input.value.trim() : "";

    if (!trainNumber) {
        showLiveError("Please enter a train number.");
        return;
    }

    const button = document.getElementById("livePredictBtn");
    const loading = document.getElementById("liveLoading");
    const result = document.getElementById("liveResult");

    /*
     * Stop any previous automatic refresh
     */
    if (livePredictionRefreshTimer) {
        clearInterval(livePredictionRefreshTimer);
        livePredictionRefreshTimer = null;
    }

    /*
     * Reset prediction tracking
     * for the newly selected train
     */
    previousPrediction = null;
    predictionTrackingCount = 0;
    predictionTrendData = [];

    if (predictionTrendChart) {
        predictionTrendChart.destroy();
        predictionTrendChart = null;
    }

    setText(
        "previousPredictionEta",
        "—"
    );

    setText(
        "latestPredictionEta",
        "—"
    );

    setText(
        "predictionEtaChange",
        "—"
    );

    setText(
        "predictionDelayChange",
        "—"
    );

    setText(
        "lastPredictionUpdate",
        "—"
    );

    setText(
        "predictionCount",
        "0"
    );

    setText(
        "predictionRefreshStatus",
        "Getting live prediction..."
    );

    activeLiveTrainNumber = trainNumber;

    if (button) {
        button.disabled = true;
    }

    if (loading) {
        loading.style.display = "block";
    }

    if (result) {
        result.style.display = "none";
    }

    try {

        /*
         * Get the first prediction immediately
         */
        await fetchLivePrediction(trainNumber);
        setLiveConnectionStatus("live");

        /*
         * Automatically refresh every 30 seconds
         */
        livePredictionRefreshTimer =
            setInterval(
                async function () {

                    /*
                     * Make sure we are still
                     * tracking the same train
                     */
                    if (
                        activeLiveTrainNumber !==
                        trainNumber
                    ) {
                        clearInterval(
                            livePredictionRefreshTimer
                        );

                        livePredictionRefreshTimer =
                            null;

                        return;
                    }

                    try {

                        setText(
                            "predictionRefreshStatus",
                            "Updating prediction..."
                        );

                        setLiveConnectionStatus("updating");

                        await fetchLivePrediction(
                            trainNumber
                        );
                        setLiveConnectionStatus("live");

                    } catch (error) {

                        console.error(
                            "Automatic live prediction refresh error:",
                            error
                        );

                        setText(
                            "predictionRefreshStatus",
                            "Refresh failed — retrying..."
                        );

                        setLiveConnectionStatus("unavailable");
                    }

                },
                (window.RAIL_ETA_REFRESH_MS || 120000)
            );

    } catch (error) {

        console.error(
            "Live prediction error:",
            error
        );

        showLiveError(
            String(error.message || "").includes("429")
                ? "Live data is temporarily rate-limited by RailRadar. Please wait and try again."
                : error.message
        );

    } finally {

        if (button) {
            button.disabled = false;
        }

        if (loading) {
            loading.style.display = "none";
        }
    }
}

async function fetchLivePrediction(trainNumber) {

    try {

        const response = await fetch(
            `/live-predict/${encodeURIComponent(trainNumber)}`
        );

        const text = await response.text();

        let data;

        try {

            data = JSON.parse(text);

        } catch {

            console.error(
                "Live server response:",
                text
            );

            throw new Error(
                "Live prediction server returned an invalid response."
            );
        }


        if (
            !response.ok ||
            data.success === false
        ) {

            throw new Error(
                data.error ||
                "Unable to get live prediction."
            );
        }


        displayLivePrediction(data);

        return data;


    } catch (error) {

        console.error(
            "Live prediction error:",
            error
        );


        /*
         * Show a user-friendly error
         */
        const result =
            document.getElementById(
                "liveResult"
            );

        if (result) {

            result.style.display =
                "block";
        }


        const liveStatus =
            document.getElementById(
                "liveStatus"
            );

        if (liveStatus) {

            liveStatus.textContent =
                "Live data temporarily unavailable";
        }


        const liveETA =
            document.getElementById(
                "liveETA"
            );

        if (liveETA) {

            liveETA.textContent =
                "Retrying...";
        }


        throw error;
    }
}

function displayLivePrediction(data) {
    const train = data.train || {};
    const live = data.live || {};
    const prediction = data.prediction || {};

    const modelInput = data.model_input || {};
    window.currentLiveModelInput = modelInput;

    setText(
        "liveTrainName",
        train.name || train.train_name || "Unknown Train"
    );

    setText(
        "liveTrainNumberResult",
        train.number || train.train_number || ""
    );

    setText(
        "liveStatus",
        train.status || "Live"
    );

    setText(
        "liveDelay",
        `${formatNumber(live.current_delay ?? 0)} min`
    );

    setText(
        "liveCurrentStation",
        live.current_station || "Unknown"
    );

    setText(
        "liveAdditionalDelay",
        `${formatNumber(prediction.additional_delay ?? 0)} min`
    );

    setText(
        "liveTotalDelay",
        `${formatNumber(prediction.total_delay ?? live.current_delay ?? 0)} min`
    );

    const predictedEta =
        prediction.predicted_eta ||
        prediction.eta ||
        data.predicted_eta ||
        data.eta ||
        null;
    updateLiveTrainPanel(
        train,
        live,
        prediction,
        predictedEta
    );

    updateETATimeline(
        train,
        live,
        prediction,
        predictedEta
    );
    updateAIAnalysis(
        train,
        live,
        prediction,
        predictedEta
    );

    updateAIExplanation(data);

    updatePredictionTracking(data);

    setText(
        "liveETA",
        predictedEta ? formatDateTime(predictedEta) : "ETA unavailable"
    );

    const result = document.getElementById("liveResult");

    if (result) {
        result.style.display = "block";
    }

    const route = Array.isArray(live.route) ? live.route : [];

    showTrainOnMap(
        live.latitude,
        live.longitude,
        train.name || "Train",
        train.number || "",
        live.current_delay ?? 0,
        live.current_station || "",
        live.next_station || "",
        predictedEta,
        route
    );
}

function initializeMap() {
    const mapElement = document.getElementById("trainMap");

    if (!mapElement || typeof L === "undefined") {
        return;
    }

    if (map) {
        return;
    }

    map = L.map("trainMap", {
        zoomControl: false
    }).setView([20.5937, 78.9629], 5);

    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap contributors"
        }
    ).addTo(map);

    L.control.zoom({
        position: "topright"
    }).addTo(map);

    addMapControls();

    setTimeout(() => {
        map.invalidateSize();
    }, 300);
}

function addMapControls() {
    if (!map) {
        return;
    }

    const Control = L.Control.extend({
        options: {
            position: "topright"
        },

        onAdd: function() {
            const container = L.DomUtil.create(
                "div",
                "leaflet-bar leaflet-control rail-map-controls"
            );

            const centerButton = createMapButton(
                container,
                "Center Train",
                () => centerTrain()
            );

            const fitButton = createMapButton(
                container,
                "Fit Route",
                () => fitRoute()
            );

            L.DomEvent.disableClickPropagation(container);

            return container;
        }
    });

    map.addControl(new Control());
}

function createMapButton(container, title, callback) {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = title;
    button.title = title;

    button.addEventListener("click", callback);

    container.appendChild(button);

    return button;
}

function showTrainOnMap(
    latitude,
    longitude,
    trainName,
    trainNumber,
    delay,
    currentStation,
    nextStation,
    eta,
    route
) {

    if (!map || typeof L === "undefined") {
        return;
    }

    addMapLiveStatus();

    if (
        latitude === null ||
        longitude === null ||
        latitude === undefined ||
        longitude === undefined
    ) {
        return;
    }

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
    ) {
        return;
    }

    /*
     * Normalize route
     */

    const normalizedRoute =
        normalizeRoute(route);

    /*
     * Draw route
     */

    drawRoute(
        normalizedRoute,
        currentStation,
        nextStation
    );


    /*
     * ==========================================
     * CALCULATE JOURNEY PROGRESS
     * ==========================================
     */
let progressPercentage = 0;

if (normalizedRoute.length > 1) {

    let totalRouteDistance = 0;
    let completedRouteDistance = 0;

    /*
     * Calculate total route distance
     */
    for (
        let i = 0;
        i < normalizedRoute.length - 1;
        i++
    ) {

        const segmentDistance =
            calculateDistanceBetweenRoutePoints(
                normalizedRoute[i],
                normalizedRoute[i + 1]
            );

        if (
            Number.isFinite(segmentDistance)
        ) {

            totalRouteDistance +=
                segmentDistance;
        }
    }

    /*
     * Find the route point closest
     * to the train's current GPS position
     */
    let closestIndex = 0;
    let closestDistance = Infinity;

    normalizedRoute.forEach(
        function(station, index) {

            const stationLat =
                Number(
                    station.latitude ??
                    station.lat
                );

            const stationLng =
                Number(
                    station.longitude ??
                    station.lng ??
                    station.lon
                );

            if (
                !Number.isFinite(stationLat) ||
                !Number.isFinite(stationLng)
            ) {
                return;
            }

            const distance =
                Math.pow(
                    stationLat - lat,
                    2
                ) +
                Math.pow(
                    stationLng - lng,
                    2
                );

            if (
                distance < closestDistance
            ) {

                closestDistance =
                    distance;

                closestIndex =
                    index;
            }
        }
    );

    /*
     * Calculate distance completed
     * up to the nearest route point
     */
    for (
        let i = 0;
        i < closestIndex;
        i++
    ) {

        const segmentDistance =
            calculateDistanceBetweenRoutePoints(
                normalizedRoute[i],
                normalizedRoute[i + 1]
            );

        if (
            Number.isFinite(segmentDistance)
        ) {

            completedRouteDistance +=
                segmentDistance;
        }
    }

    /*
     * Convert completed distance
     * into journey percentage
     */
    if (
        totalRouteDistance > 0
    ) {

        progressPercentage =
            (
                completedRouteDistance /
                totalRouteDistance
            ) * 100;
    }
}
    progressPercentage =
        Math.min(
            Math.max(
                progressPercentage,
                0
            ),
            100
        );

    const roundedProgress =
        Math.round(
            progressPercentage
        );


    /*
     * ==========================================
     * TRAIN ICON
     * ==========================================
     */

    const trainIcon = L.divIcon({

        className:
            "train-map-icon",

        html:
            '<div class="train-marker">🚆</div>',

        iconSize: [
            42,
            42
        ],

        iconAnchor: [
            21,
            21
        ],

        popupAnchor: [
            0,
            -20
        ]
    });


    /*
     * ==========================================
     * CREATE TRAIN MARKER
     * ==========================================
     */

    if (!trainMarker) {

        trainMarker =
            L.marker(
                [
                    lat,
                    lng
                ],
                {
                    icon: trainIcon,
                    zIndexOffset: 1000
                }
            ).addTo(map);
    }


    /*
     * ==========================================
     * POPUP
     * ==========================================
     */

    const popupHtml = `
        <div class="train-popup">

            <strong>
                ${escapeHtml(trainName)}
            </strong>

            <div>
                Train:
                ${escapeHtml(trainNumber)}
            </div>

            <div>
                Delay:
                ${formatNumber(delay)} min
            </div>

            <div>
                Current:
                ${escapeHtml(
                    currentStation ||
                    "Unknown"
                )}
            </div>

            <div>
                Next:
                ${escapeHtml(
                    nextStation ||
                    "Unknown"
                )}
            </div>

            <div>
                AI ETA:
                ${escapeHtml(
                    eta
                        ? formatDateTime(eta)
                        : "Unavailable"
                )}
            </div>

            <div class="train-popup-progress">

                <div
                    class="train-popup-progress-label"
                >
                    Journey Progress
                    <strong>
                        ${roundedProgress}%
                    </strong>
                </div>

                <div
                    class="train-popup-progress-bar"
                >
                    <div
                        class="train-popup-progress-fill"
                        style="
                            width: ${roundedProgress}%;
                        "
                    ></div>
                </div>

            </div>

        </div>
    `;


    trainMarker.bindPopup(
        popupHtml
    );


    /*
     * ==========================================
     * MOVE TRAIN MARKER
     * ==========================================
     */

    const currentPosition =
        trainMarker.getLatLng();

    if (
        firstMapRender ||
        Math.abs(
            currentPosition.lat - lat
        ) > 2 ||
        Math.abs(
            currentPosition.lng - lng
        ) > 2
    ) {

        trainMarker.setLatLng(
            [
                lat,
                lng
            ]
        );

    } else {

        animateTrainMarker(
            currentPosition.lat,
            currentPosition.lng,
            lat,
            lng,
            3000
        );
    }


    /*
     * ==========================================
     * INITIAL MAP POSITION
     * ==========================================
     */

    if (firstMapRender) {

        map.setView(
            [
                lat,
                lng
            ],
            10
        );

        firstMapRender = false;
    }


    /*
     * Fix Leaflet rendering
     */

    setTimeout(
        function() {

            map.invalidateSize();

        },
        100
    );
}

function normalizeRoute(route) {
    return route
        .map(item => {
            const lat = Number(
                item.latitude ??
                item.lat ??
                item.location?.latitude
            );

            const lng = Number(
                item.longitude ??
                item.lng ??
                item.location?.longitude
            );

            const station =
                item.station ||
                item.name ||
                item.station_name ||
                item.stationName ||
                "";

            const sequence = Number(
                item.sequence ??
                item.seq ??
                item.stationSequence ??
                0
            );

            return {
                lat,
                lng,
                station,
                sequence,
                status: item.status || ""
            };
        })
        .filter(item =>
            Number.isFinite(item.lat) &&
            Number.isFinite(item.lng)
        );
}

function drawRoute(route, currentStation, nextStation) {
    if (!map || !route.length) {
        return;
    }

    if (routeLayer) {
        map.removeLayer(routeLayer);
    }

    if (activeRouteLayer) {
        map.removeLayer(activeRouteLayer);
    }

    if (stationLayer) {
        map.removeLayer(stationLayer);
    }

    const points = route.map(item => [item.lat, item.lng]);

    routeLayer = L.polyline(points, {
        weight: 5,
        opacity: 0.45
    }).addTo(map);

    const currentIndex = findStationIndex(
        route,
        currentStation
    );

    const nextIndex = findStationIndex(
        route,
        nextStation
    );

    if (currentIndex >= 0) {
        const activeEnd =
            nextIndex > currentIndex
                ? nextIndex
                : currentIndex;

        const activePoints = route
            .slice(0, activeEnd + 1)
            .map(item => [item.lat, item.lng]);

        if (activePoints.length >= 2) {
            activeRouteLayer = L.polyline(activePoints, {
                weight: 7,
                opacity: 0.9
            }).addTo(map);
        }
    }

    stationLayer = L.layerGroup().addTo(map);

    route.forEach((station, index) => {
        let className = "route-station-marker";

        if (index === currentIndex) {
            className += " current-station-marker";
        }

        if (index === nextIndex) {
            className += " next-station-marker";
        }

        const icon = L.divIcon({
            className,
            html: '<span></span>',
            iconSize: [18, 18],
            iconAnchor: [9, 9]
        });

        const marker = L.marker(
            [station.lat, station.lng],
            { icon }
        );

        marker.bindTooltip(
            station.station || "Station",
            {
                direction: "top",
                offset: [0, -8]
            }
        );

        marker.addTo(stationLayer);
    });
}

function findStationIndex(route, stationName) {
    if (!stationName) {
        return -1;
    }

    const target = String(stationName)
        .toLowerCase()
        .trim();

    return route.findIndex(item =>
        String(item.station)
            .toLowerCase()
            .trim() === target
    );
}

function animateTrainMarker(
    startLat,
    startLng,
    endLat,
    endLng,
    duration
) {
    if (!trainMarker) {
        return;
    }

    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
    }

    const startTime = performance.now();

    function animate(currentTime) {
        const progress = Math.min(
            (currentTime - startTime) / duration,
            1
        );

        const eased =
            progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        const lat =
            startLat + (endLat - startLat) * eased;

        const lng =
            startLng + (endLng - startLng) * eased;

        trainMarker.setLatLng([lat, lng]);

        if (progress < 1) {
            animationFrame = requestAnimationFrame(animate);
        }
    }

    animationFrame = requestAnimationFrame(animate);
}

function centerTrain() {
    if (!map || !trainMarker) {
        return;
    }

    map.setView(
        trainMarker.getLatLng(),
        Math.max(map.getZoom(), 10),
        {
            animate: true
        }
    );
}

function fitRoute() {
    if (!map || !routeLayer) {
        return;
    }

    map.fitBounds(
        routeLayer.getBounds(),
        {
            padding: [30, 30],
            animate: true
        }
    );
}

async function loadHistory() {

    const container =
        document.getElementById(
            "historyContainer"
        );

    if (!container) {
        return;
    }

    try {

        const response =
            await fetch("/history");

        const data =
            await response.json();

        const history =
            Array.isArray(data)
                ? data
                : data.history || [];

        if (!history.length) {

            container.innerHTML =
                "<p>No prediction history available.</p>";

            return;
        }

        const visibleHistory = history.slice(0, 5);

        container.innerHTML =
            visibleHistory
                .map(
                    function(item, index) {

                        const trainName =
                            item.train_name ||
                            item.train ||
                            "Unknown Train";

                        const currentDelay =
                            Number(
                                item.current_delay ?? 0
                            );

                        const additionalDelay =
                            Number(
                                item.predicted_additional_delay ??
                                0
                            );

                        const totalDelay =
                            Number(
                                item.total_delay ??
                                item.predicted_delay ??
                                0
                            );

                        const predictionTime =
                            item.prediction_time
                                ? formatDateTime(
                                    item.prediction_time
                                )
                                : "--";

                        const predictedEta =
                            item.predicted_eta
                                ? formatDateTime(
                                    item.predicted_eta
                                )
                                : "--";


                        // ==========================================
                        // DETERMINE CHANGE FROM PREVIOUS RECORD
                        // ==========================================

                        let changeText =
                            "→ Stable";

                        let changeClass =
                            "history-change-stable";


                        if (
                            index <
                            visibleHistory.length - 1
                        ) {

                            const previousItem =
                                visibleHistory[index + 1];

                            const previousTotalDelay =
                                Number(
                                    previousItem.total_delay ??
                                    previousItem.predicted_delay ??
                                    0
                                );

                            const difference =
                                totalDelay -
                                previousTotalDelay;


                            if (difference >= 1) {

                                changeText =
                                    `↑ Worsening (+${formatNumber(
                                        difference
                                    )} min)`;

                                changeClass =
                                    "history-change-worsening";

                            } else if (
                                difference <= -1
                            ) {

                                changeText =
                                    `↓ Improving (${formatNumber(
                                        difference
                                    )} min)`;

                                changeClass =
                                    "history-change-improving";
                            }
                        }


                        // ==========================================
                        // DELAY STATUS
                        // ==========================================

                        let status =
                            "On Time";

                        if (totalDelay > 30) {

                            status =
                                "Significantly Delayed";

                        } else if (totalDelay > 5) {

                            status =
                                "Delayed";
                        }


                        return `
                            <div
                                class="history-item"
                            >

                                <div
                                    class="history-main"
                                >

                                    <strong>
                                        ${escapeHtml(
                                            trainName
                                        )}
                                    </strong>

                                    <span
                                        class="history-status"
                                    >
                                        ${escapeHtml(
                                            status
                                        )}
                                    </span>

                                </div>


                                <div
                                    class="history-details"
                                >

                                    <span>
                                        Current Delay:
                                        <strong>
                                            ${formatNumber(
                                                currentDelay
                                            )} min
                                        </strong>
                                    </span>


                                    <span>
                                        AI Additional Delay:
                                        <strong>
                                            ${formatNumber(
                                                additionalDelay
                                            )} min
                                        </strong>
                                    </span>


                                    <span>
                                        Total Predicted Delay:
                                        <strong>
                                            ${formatNumber(
                                                totalDelay
                                            )} min
                                        </strong>
                                    </span>


                                    <span>
                                        Prediction Change:
                                        <strong
                                            class="${changeClass}"
                                        >
                                            ${escapeHtml(
                                                changeText
                                            )}
                                        </strong>
                                    </span>


                                    <span>
                                        Predicted ETA:
                                        <strong>
                                            ${escapeHtml(
                                                predictedEta
                                            )}
                                        </strong>
                                    </span>


                                    <span>
                                        Prediction Updated:
                                        <strong>
                                            ${escapeHtml(
                                                predictionTime
                                            )}
                                        </strong>
                                    </span>

                                </div>

                            </div>
                        `;
                    }
                )
                .join("");

    } catch (error) {

        console.error(
            "History error:",
            error
        );

        container.innerHTML =
            "<p>Unable to load prediction history.</p>";
    }
}

async function loadDashboardStats() {
    try {
        const response = await fetch("/history");
        const data = await response.json();

        const history = Array.isArray(data)
            ? data
            : data.history || [];

        setText("totalPredictions", history.length);

        if (!history.length) {
            setText("averageDelay", "0 min");
            setText("latestTrain", "--");
            setText("latestEta", "--");
            return;
        }

        const delays = history.map(item =>
            Number(
                item.total_delay ??
                item.predicted_delay ??
                0
            )
        );

        const average =
            delays.reduce((sum, value) => sum + value, 0) /
            delays.length;

        const latest = history[history.length - 1];

        setText(
            "averageDelay",
            `${average.toFixed(1)} min`
        );

        setText(
            "latestTrain",
            latest.train_name ||
            latest.train ||
            "--"
        );

        setText(
            "latestEta",
            latest.predicted_eta
                ? formatDateTime(latest.predicted_eta)
                : "--"
        );
    } catch (error) {
        console.error("Dashboard error:", error);
    }
}

async function loadFeatureImportance() {
    const canvas = document.getElementById("importanceChart");

    if (!canvas || typeof Chart === "undefined") {
        return;
    }

    try {
        const response = await fetch("/feature-importance");
        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || "Unable to load feature importance."
            );
        }

        let features =
            data.features ||
            data.feature_importance ||
            data.importance ||
            data;

        let labels = [];
        let values = [];

        if (Array.isArray(features)) {
            features.forEach(item => {
                const name =
                    item.feature ||
                    item.name ||
                    item.label;

                const value =
                    item.importance ??
                    item.value ??
                    item.score ??
                    0;

                if (name) {
                    labels.push(formatFeatureName(name));
                    values.push(Number(value));
                }
            });
        } else if (
            features &&
            typeof features === "object"
        ) {
            Object.entries(features).forEach(
                ([name, value]) => {
                    labels.push(formatFeatureName(name));
                    values.push(Number(value));
                }
            );
        }

        if (!labels.length) {
            return;
        }

        const sorted = labels
            .map((label, index) => ({
                label,
                value: Number(values[index]) || 0
            }))
            .sort((a, b) => b.value - a.value);

        labels = sorted.map(item => item.label);
        values = sorted.map(item => item.value);

        const existingChart =
            Chart.getChart(canvas);

        if (existingChart) {
            existingChart.destroy();
        }

        new Chart(canvas, {
            type: "bar",
            data: {
                labels,
                datasets: [
                    {
                        label: "Model Importance",
                        data: values,
                        borderWidth: 0,
                        borderRadius: 7
                    }
                ]
            },
            options: {
                indexAxis: "y",
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return ` Importance: ${Number(
                                    context.raw
                                ).toFixed(3)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: {
                            precision: 2
                        },
                        title: {
                            display: true,
                            text: "Importance Score"
                        }
                    },
                    y: {
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });

        updateFeatureImportanceCards(
            labels,
            values
        );

    } catch (error) {
        console.error(
            "Feature importance error:",
            error
        );
    }
}

function showLiveError(message) {
    const errorElement = document.getElementById("liveError");

    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = "block";
    }

    const result = document.getElementById("liveResult");

    if (result) {
        result.style.display = "none";
    }
}

function setStatus(element, text, type) {
    if (!element) {
        return;
    }

    element.textContent = text;
    element.classList.remove(
        "success",
        "error",
        "loading"
    );

    if (type) {
        element.classList.add(type);
    }
}

function setText(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.textContent = value;
    }
}

function setValue(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.value = value;
    }
}

function getValue(id) {
    const element = document.getElementById(id);

    return element ? element.value : "";
}

function getNumber(id) {
    const value = Number(getValue(id));

    return Number.isFinite(value) ? value : 0;
}

function formatNumber(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "0";
    }

    return Number.isInteger(number)
        ? String(number)
        : number.toFixed(1);
}

function formatDateTime(value) {
    if (!value) {
        return "Unavailable";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function addMapLiveStatus() {
    if (!map) {
        return;
    }

    let statusControl = document.getElementById("mapLiveStatus");

    if (!statusControl) {
        const Control = L.Control.extend({
            options: {
                position: "topleft"
            },

            onAdd: function() {
                const container = L.DomUtil.create(
                    "div",
                    "map-live-status"
                );

                container.id = "mapLiveStatus";

                container.innerHTML = `
                    <div class="map-live-badge">
                        <span class="map-live-dot"></span>
                        LIVE
                    </div>
                    <div class="map-last-updated">
                        Last updated: <span id="mapUpdatedTime">--</span>
                    </div>
                `;

                L.DomEvent.disableClickPropagation(container);

                return container;
            }
        });

        map.addControl(new Control());

        statusControl = document.getElementById("mapLiveStatus");
    }

    const updatedTime = document.getElementById("mapUpdatedTime");

    if (updatedTime) {
        updatedTime.textContent = new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
    }
}

function updateLiveTrainPanel(train, live, prediction, predictedEta) {
    const mapElement = document.getElementById("trainMap");

    if (!mapElement) {
        return;
    }

    let panel = document.getElementById("liveTrainPanel");

    if (!panel) {
        panel = document.createElement("div");
        panel.id = "liveTrainPanel";
        panel.className = "live-train-panel";

        mapElement.parentNode.insertBefore(panel, mapElement);
    }

    const trainName =
        train.name ||
        train.train_name ||
        "Unknown Train";

    const trainNumber =
        train.number ||
        train.train_number ||
        "";

    const currentStation =
        live.current_station ||
        "Unknown";

    const nextStation =
        live.next_station ||
        "Unknown";

    const currentDelay =
        Number(live.current_delay ?? 0);

    const additionalDelay =
        Number(prediction.additional_delay ?? 0);

    const totalDelay =
        Number(
            prediction.total_delay ??
            currentDelay + additionalDelay
        );

    const etaText =
        predictedEta
            ? formatDateTime(predictedEta)
            : "ETA unavailable";

    const status =
        train.status ||
        "Running";

    panel.innerHTML = `
        <div class="live-panel-header">
            <div>
                <div class="live-panel-label">
                    LIVE TRAIN TRACKING
                </div>

                <h3>
                    🚆 ${escapeHtml(trainName)}
                </h3>

                <span class="live-train-number">
                    Train ${escapeHtml(trainNumber)}
                </span>
            </div>

            <div class="live-running-status">
                <span class="live-status-dot"></span>
                ${escapeHtml(status)}
            </div>
        </div>

        <div class="live-panel-route">

            <div class="route-point current-point">
                <div class="route-icon">
                    📍
                </div>

                <div class="route-info">
                    <span class="route-label">
                        CURRENT STATION
                    </span>

                    <strong>
                        ${escapeHtml(currentStation)}
                    </strong>
                </div>
            </div>

            <div class="route-line"></div>

            <div class="route-point next-point">
                <div class="route-icon">
                    🟠
                </div>

                <div class="route-info">
                    <span class="route-label">
                        NEXT STATION
                    </span>

                    <strong>
                        ${escapeHtml(nextStation)}
                    </strong>
                </div>
            </div>

        </div>

        <div class="live-panel-stats">

            <div class="live-stat-card">
                <span class="live-stat-icon">
                    ⏱️
                </span>

                <div>
                    <small>
                        CURRENT DELAY
                    </small>

                    <strong>
                        +${formatNumber(currentDelay)} min
                    </strong>
                </div>
            </div>

            <div class="live-stat-card">
                <span class="live-stat-icon">
                    🤖
                </span>

                <div>
                    <small>
                        AI ADDITIONAL DELAY
                    </small>

                    <strong>
                        +${formatNumber(additionalDelay)} min
                    </strong>
                </div>
            </div>

            <div class="live-stat-card">
                <span class="live-stat-icon">
                    ⚠️
                </span>

                <div>
                    <small>
                        TOTAL PREDICTED DELAY
                    </small>

                    <strong>
                        +${formatNumber(totalDelay)} min
                    </strong>
                </div>
            </div>

            <div class="live-stat-card eta-card">
                <span class="live-stat-icon">
                    🕐
                </span>

                <div>
                    <small>
                        AI PREDICTED ETA
                    </small>

                    <strong>
                        ${escapeHtml(etaText)}
                    </strong>
                </div>
            </div>

        </div>
    `;
}

function updateAIAnalysis(train, live, prediction, predictedEta) {
    const mapElement = document.getElementById("trainMap");

    if (!mapElement) {
        return;
    }

    let section = document.getElementById("aiAnalysisSection");

    if (!section) {
        section = document.createElement("section");
        section.id = "aiAnalysisSection";
        section.className = "ai-analysis-section";

        mapElement.parentNode.parentNode.insertBefore(
            section,
            mapElement.parentNode
        );
    }

    const currentDelay = Number(
        live.current_delay ?? 0
    );

    const additionalDelay = Number(
        prediction.additional_delay ?? 0
    );

    const totalDelay = Number(
        prediction.total_delay ??
        currentDelay + additionalDelay
    );

    const modelInput = window.currentLiveModelInput || {};

    const distance = Number(
        modelInput.distance_remaining ??
        live.distance_remaining ??
        live.distanceFromDestination ??
        0
    );

    const stops = Number(
        modelInput.stops_remaining ??
        live.stops_remaining ??
        0
    );

    const historicalDelay = Number(
        modelInput.historical_avg_delay ??
        live.historical_avg_delay ??
        live.historicalAverageDelay ??
        0
    );

    const etaText = predictedEta
        ? formatDateTime(predictedEta)
        : "ETA unavailable";

    section.innerHTML = `
        <div class="ai-analysis-header">
            <div>
                <span class="ai-section-label">
                    ARTIFICIAL INTELLIGENCE
                </span>

                <h2>
                    🤖 AI Prediction Analysis
                </h2>

                <p>
                    RailETA analyzes live and historical railway data
                    to estimate additional delay and expected arrival time.
                </p>
            </div>

            <div class="ai-model-badge">
                ML MODEL
            </div>
        </div>

        <div class="ai-input-grid">

            <div class="ai-input-card">
                <span class="ai-input-icon">⏱️</span>

                <div>
                    <small>Current Delay</small>
                    <strong>
                        ${formatNumber(currentDelay)} min
                    </strong>
                </div>
            </div>

            <div class="ai-input-card">
                <span class="ai-input-icon">🛤️</span>

                <div>
                    <small>Distance Remaining</small>
                    <strong>
                        ${formatNumber(distance)} km
                    </strong>
                </div>
            </div>

            <div class="ai-input-card">
                <span class="ai-input-icon">🚉</span>

                <div>
                    <small>Stops Remaining</small>
                    <strong>
                        ${formatNumber(stops)}
                    </strong>
                </div>
            </div>

            <div class="ai-input-card">
                <span class="ai-input-icon">📊</span>

                <div>
                    <small>Historical Avg. Delay</small>
                    <strong>
                        ${formatNumber(historicalDelay)} min
                    </strong>
                </div>
            </div>

        </div>

        <div class="ai-result-grid">

            <div class="ai-result-card">
                <span>AI ADDITIONAL DELAY</span>

                <strong>
                    +${formatNumber(additionalDelay)}
                </strong>

                <small>
                    minutes
                </small>
            </div>

            <div class="ai-result-card total-result">
                <span>EXPECTED TOTAL DELAY</span>

                <strong>
                    +${formatNumber(totalDelay)}
                </strong>

                <small>
                    minutes
                </small>
            </div>

            <div class="ai-result-card eta-result">
                <span>AI PREDICTED ETA</span>

                <strong>
                    ${escapeHtml(etaText)}
                </strong>

                <small>
                    expected arrival
                </small>
            </div>

        </div>

        <div class="ai-explanation">
            <div class="ai-explanation-icon">
                💡
            </div>

            <div>
                <strong>
                    How RailETA predicts delay
                </strong>

                <p>
                    The machine-learning model combines the train's
                    current delay, remaining journey distance,
                    remaining stops, and historical delay behavior
                    to estimate additional delay.
                </p>
            </div>
        </div>

        <div class="ai-flow">

            <div class="ai-flow-item">
                <span>1</span>
                <strong>Live Data</strong>
                <small>Current train status</small>
            </div>

            <div class="ai-flow-arrow">→</div>

            <div class="ai-flow-item">
                <span>2</span>
                <strong>Feature Analysis</strong>
                <small>Delay + route factors</small>
            </div>

            <div class="ai-flow-arrow">→</div>

            <div class="ai-flow-item">
                <span>3</span>
                <strong>ML Prediction</strong>
                <small>Additional delay</small>
            </div>

            <div class="ai-flow-arrow">→</div>

            <div class="ai-flow-item">
                <span>4</span>
                <strong>ETA</strong>
                <small>${escapeHtml(etaText)}</small>
            </div>

        </div>
    `;
}

function formatFeatureName(name) {
    return String(name)
        .replace(/_/g, " ")
        .replace(/\b\w/g, letter =>
            letter.toUpperCase()
        );
}

function updateFeatureImportanceCards(
    labels,
    values
) {
    const canvas =
        document.getElementById("importanceChart");

    if (!canvas || !labels.length) {
        return;
    }

    const chartContainer =
        canvas.parentElement;

    if (!chartContainer) {
        return;
    }

    let section =
        document.getElementById(
            "featureImportanceDetails"
        );

    if (!section) {
        section = document.createElement("div");

        section.id =
            "featureImportanceDetails";

        section.className =
            "feature-importance-details";

        chartContainer.parentNode.insertBefore(
            section,
            chartContainer.nextSibling
        );
    }

    const maxValue =
        Math.max(...values);

    section.innerHTML = `
        <div class="importance-details-header">
            <div>
                <span>
                    MODEL EXPLAINABILITY
                </span>

                <h3>
                    🧠 What influences the prediction?
                </h3>

                <p>
                    The Random Forest model evaluates these
                    railway-delay features to estimate
                    additional delay.
                </p>
            </div>
        </div>

        <div class="importance-list">

            ${labels.map((label, index) => {
                const value =
                    Number(values[index]) || 0;

                const percentage =
                    maxValue > 0
                        ? (value / maxValue) * 100
                        : 0;

                return `
                    <div class="importance-item">

                        <div class="importance-item-top">
                            <strong>
                                ${escapeHtml(label)}
                            </strong>

                            <span>
                                ${value.toFixed(3)}
                            </span>
                        </div>

                        <div class="importance-bar">
                            <div
                                class="importance-bar-fill"
                                style="width:${percentage}%"
                            ></div>
                        </div>

                    </div>
                `;
            }).join("")}

        </div>

        <div class="model-explanation-box">
            <div class="model-explanation-icon">
                🤖
            </div>

            <div>
                <strong>
                    Random Forest Delay Prediction
                </strong>

                <p>
                    RailETA combines current operational delay,
                    remaining journey distance, remaining stops,
                    and historical delay behavior to estimate
                    how much additional delay may occur.
                </p>
            </div>
        </div>
    `;
}

/* =========================================================
   MODEL PERFORMANCE
========================================================= */

let modelPerformanceChart = null;


/* ---------------------------------------------------------
   Load model performance
--------------------------------------------------------- */

async function loadModelPerformance() {

    const statusElement =
        document.getElementById(
            "modelPerformanceStatus"
        );

    if (!statusElement) {
        return;
    }

    try {

        statusElement.textContent =
            "Checking model...";

        const response = await fetch(
            "/model-performance"
        );

        const data = await response.json();

        if (!data.available) {

            showModelEvaluationUnavailable(
                data.message ||
                "A labelled evaluation dataset is required."
            );

            statusElement.textContent =
                "Evaluation pending";

            return;
        }


        if (!data.success) {

            showModelEvaluationUnavailable(
                data.message ||
                "Unable to evaluate model."
            );

            statusElement.textContent =
                "Evaluation error";

            return;
        }


        // Hide notice
        const notice =
            document.getElementById(
                "modelEvaluationNotice"
            );

        if (notice) {
            notice.style.display = "none";
        }


        statusElement.textContent =
            "Evaluation available";


        // --------------------------------------------------
        // Metrics
        // --------------------------------------------------

        const mae =
            document.getElementById(
                "modelMAE"
            );

        const rmse =
            document.getElementById(
                "modelRMSE"
            );

        const r2 =
            document.getElementById(
                "modelR2"
            );

        const samples =
            document.getElementById(
                "modelSamples"
            );


        if (mae) {
            mae.textContent =
                data.metrics.mae.toFixed(2);
        }

        if (rmse) {
            rmse.textContent =
                data.metrics.rmse.toFixed(2);
        }

        if (r2) {
            r2.textContent =
                data.metrics.r2.toFixed(3);
        }

        if (samples) {
            samples.textContent =
                data.samples.total;
        }


        // --------------------------------------------------
        // Model information
        // --------------------------------------------------

        const modelType =
            document.getElementById(
                "modelType"
            );

        const modelEstimators =
            document.getElementById(
                "modelEstimators"
            );

        const modelFeatures =
            document.getElementById(
                "modelFeatures"
            );


        if (modelType) {

            modelType.textContent =
                data.model.type;
        }


        if (modelEstimators) {

            modelEstimators.textContent =
                data.model.estimators ||
                "—";
        }


        if (modelFeatures) {

            modelFeatures.textContent =
                data.model.features;
        }


        // --------------------------------------------------
        // Actual vs predicted chart
        // --------------------------------------------------

        createModelPerformanceChart(
            data.comparison
        );


        // --------------------------------------------------
        // Feature importance
        // --------------------------------------------------

        renderModelFeatureImportance(
            data.feature_importance
        );


    } catch (error) {

        console.error(
            "Model performance error:",
            error
        );

        showModelEvaluationUnavailable(
            "Could not connect to the model performance service."
        );

        statusElement.textContent =
            "Connection error";
    }
}


/* ---------------------------------------------------------
   Show unavailable message
--------------------------------------------------------- */

function showModelEvaluationUnavailable(
    message
) {

    const notice =
        document.getElementById(
            "modelEvaluationNotice"
        );

    const noticeText =
        document.getElementById(
            "modelEvaluationNoticeText"
        );


    if (notice) {
        notice.style.display = "flex";
    }


    if (noticeText) {

        noticeText.textContent =
            message;
    }


    // Reset metrics

    const ids = [
        "modelMAE",
        "modelRMSE",
        "modelR2",
        "modelSamples",
        "modelType",
        "modelEstimators",
        "modelFeatures"
    ];


    ids.forEach(function(id) {

        const element =
            document.getElementById(id);

        if (element) {
            element.textContent = "—";
        }

    });


    const featureContainer =
        document.getElementById(
            "modelFeatureImportance"
        );

    if (featureContainer) {

        featureContainer.innerHTML = `
            <div class="model-empty-state">
                Feature importance will appear
                when evaluation data is available.
            </div>
        `;
    }


    if (modelPerformanceChart) {

        modelPerformanceChart.destroy();

        modelPerformanceChart = null;
    }
}


/* ---------------------------------------------------------
   Actual vs predicted chart
--------------------------------------------------------- */

function createModelPerformanceChart(
    comparison
) {

    const canvas =
        document.getElementById(
            "modelPerformanceChart"
        );

    if (!canvas) {
        return;
    }


    const labels =
        comparison.map(
            function(_, index) {
                return index + 1;
            }
        );


    const actual =
        comparison.map(
            function(item) {
                return item.actual;
            }
        );


    const predicted =
        comparison.map(
            function(item) {
                return item.predicted;
            }
        );


    if (modelPerformanceChart) {

        modelPerformanceChart.destroy();
    }


    modelPerformanceChart =
        new Chart(
            canvas.getContext("2d"),
            {
                type: "line",

                data: {

                    labels: labels,

                    datasets: [

                        {
                            label:
                                "Actual Delay",

                            data:
                                actual,

                            tension: 0.3,

                            borderWidth: 2,

                            pointRadius: 3
                        },

                        {
                            label:
                                "Predicted Delay",

                            data:
                                predicted,

                            tension: 0.3,

                            borderWidth: 2,

                            pointRadius: 3
                        }

                    ]
                },

                options: {

                    responsive: true,

                    maintainAspectRatio: false,

                    interaction: {
                        mode: "index",
                        intersect: false
                    },

                    plugins: {

                        legend: {
                            display: true
                        }

                    },

                    scales: {

                        x: {
                            title: {
                                display: true,
                                text:
                                    "Evaluation Sample"
                            }
                        },

                        y: {
                            title: {
                                display: true,
                                text:
                                    "Additional Delay (minutes)"
                            }
                        }

                    }

                }
            }
        );
}


/* ---------------------------------------------------------
   Feature importance
--------------------------------------------------------- */

function renderModelFeatureImportance(
    features
) {

    const container =
        document.getElementById(
            "modelFeatureImportance"
        );

    if (!container) {
        return;
    }


    if (
        !features ||
        features.length === 0
    ) {

        container.innerHTML = `
            <div class="model-empty-state">
                Feature importance unavailable.
            </div>
        `;

        return;
    }


    const maxImportance =
        Math.max.apply(
            null,
            features.map(
                function(item) {
                    return item.importance;
                }
            )
        );


    container.innerHTML = "";


    features.forEach(
        function(item) {

            const percentage =
                maxImportance > 0
                    ? (
                        item.importance /
                        maxImportance
                    ) * 100
                    : 0;


            const displayPercentage =
                (
                    item.importance * 100
                ).toFixed(1);


            const row =
                document.createElement(
                    "div"
                );

            row.className =
                "model-feature-row";


            row.innerHTML = `

                <div class="model-feature-row-header">

                    <span class="model-feature-name">
                        ${formatModelFeatureName(
                            item.feature
                        )}
                    </span>

                    <span class="model-feature-value">
                        ${displayPercentage}%
                    </span>

                </div>

                <div class="model-feature-bar">

                    <div
                        class="model-feature-bar-fill"
                        style="width: ${percentage}%"
                    ></div>

                </div>

            `;


            container.appendChild(row);
        }
    );
}


/* ---------------------------------------------------------
   Feature name formatter
--------------------------------------------------------- */

function formatModelFeatureName(
    feature
) {

    const names = {

        current_delay:
            "Current Delay",

        distance_remaining:
            "Distance Remaining",

        stops_remaining:
            "Stops Remaining",

        historical_avg_delay:
            "Historical Average Delay"

    };


    return (
        names[feature] ||
        feature
            .replaceAll("_", " ")
            .replace(/\b\w/g, function(letter) {
                return letter.toUpperCase();
            })
    );
}

/* =========================================================
   ETA TIMELINE EXPANDED VIEW STATE
========================================================= */
window.railEtaTimelineExpanded =
    window.railEtaTimelineExpanded || false;

function toggleETATimelineStations() {
    window.railEtaTimelineExpanded =
        !window.railEtaTimelineExpanded;

    if (
        typeof window.lastRailEtaTimelineArgs === "object" &&
        window.lastRailEtaTimelineArgs
    ) {
        updateETATimeline(
            window.lastRailEtaTimelineArgs.train,
            window.lastRailEtaTimelineArgs.live,
            window.lastRailEtaTimelineArgs.prediction,
            window.lastRailEtaTimelineArgs.predictedEta
        );
    }
}

/* =========================================================
   ETA PREDICTION TIMELINE
========================================================= */


/*
 * Build a station-by-station ETA forecast.
 *
 * The live API route already gives us the remaining route.
 * We use the predicted final ETA and distribute the remaining
 * travel time across the remaining route points.
 *
 * This is a forecast visualization, not a claim that the API
 * provides an independent ETA for every station.
 */
function updateETATimeline(
    train,
    live,
    prediction,
    predictedEta
) {

    window.lastRailEtaTimelineArgs = {
        train: train,
        live: live,
        prediction: prediction,
        predictedEta: predictedEta
    };

    const timeline =
        document.getElementById(
            "etaTimeline"
        );

    if (!timeline) {
        return;
    }

    setText(
        "timelineCurrentStation",
        live.current_station || "—"
    );

    setText(
        "timelineNextStation",
        live.next_station || "—"
    );

    setText(
        "timelineCurrentDelay",
        formatDelay(
            live.current_delay
        )
    );

    setText(
        "timelineFinalEta",
        formatTimelineDate(
            predictedEta
        )
    );

    const route =
        Array.isArray(live.route)
            ? live.route
            : [];

    if (route.length === 0) {

        timeline.innerHTML = `
            <div class="timeline-empty">

                <div class="timeline-empty-icon">
                    ⏱
                </div>

                <h3>
                    Route forecast unavailable
                </h3>

                <p>
                    The live service did not return
                    enough route information.
                </p>

            </div>
        `;

        return;
    }

    /*
     * Find the train's CURRENT station.
     *
     * RailRadar can return a station name/code that is not written
     * exactly the same way as the route station name. Therefore:
     *
     * 1. Try exact station-name/code match.
     * 2. Try a safe partial-name match.
     * 3. If current station is unavailable, use the next station
     *    and select the station immediately before it.
     * 4. As a final fallback, use the live GPS position to find
     *    the nearest route station.
     *
     * This keeps the existing ETA calculation unchanged.
     */
    let currentIndex = 0;

    const normalizeTimelineStation = function(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim();
    };

    const currentName = normalizeTimelineStation(
        live.current_station
    );

    let foundIndex = -1;

    /*
     * 1. Exact station name / code match.
     */
    if (currentName) {
        foundIndex = route.findIndex(
            function(station) {
                const name = normalizeTimelineStation(
                    getRouteStationName(station)
                );

                const code = normalizeTimelineStation(
                    getRouteStationCode(station)
                );

                return (
                    name === currentName ||
                    code === currentName
                );
            }
        );
    }

    /*
     * 2. Safe partial match.
     * Example:
     * "Bhubaneswar" ↔ "Bhubaneswar Jn"
     */
    if (foundIndex < 0 && currentName) {
        foundIndex = route.findIndex(
            function(station) {
                const name = normalizeTimelineStation(
                    getRouteStationName(station)
                );

                const code = normalizeTimelineStation(
                    getRouteStationCode(station)
                );

                return (
                    (name && (
                        name.includes(currentName) ||
                        currentName.includes(name)
                    )) ||
                    (code && (
                        code.includes(currentName) ||
                        currentName.includes(code)
                    ))
                );
            }
        );
    }

    /*
     * 3. If current station cannot be matched, use the next
     * station returned by the live API. The current station is
     * normally the route point immediately before that station.
     */
    if (
        foundIndex < 0 &&
        live.next_station
    ) {
        const nextName = normalizeTimelineStation(
            live.next_station
        );

        let nextIndex = route.findIndex(
            function(station) {
                const name = normalizeTimelineStation(
                    getRouteStationName(station)
                );

                const code = normalizeTimelineStation(
                    getRouteStationCode(station)
                );

                return (
                    name === nextName ||
                    code === nextName ||
                    (name && (
                        name.includes(nextName) ||
                        nextName.includes(name)
                    )) ||
                    (code && (
                        code.includes(nextName) ||
                        nextName.includes(code)
                    ))
                );
            }
        );

        if (nextIndex > 0) {
            foundIndex = nextIndex - 1;
        }
    }

    /*
     * 4. Final fallback: use the live GPS position.
     * This identifies the closest station on the route without
     * changing the route or ETA calculations.
     */
    if (
        foundIndex < 0 &&
        Number.isFinite(Number(live.latitude)) &&
        Number.isFinite(Number(live.longitude))
    ) {
        const trainLat = Number(live.latitude);
        const trainLng = Number(live.longitude);

        let closestDistance = Infinity;

        route.forEach(
            function(station, index) {
                const stationLat = Number(
                    station.latitude ??
                    station.lat ??
                    station.location?.latitude
                );

                const stationLng = Number(
                    station.longitude ??
                    station.lng ??
                    station.location?.longitude
                );

                if (
                    !Number.isFinite(stationLat) ||
                    !Number.isFinite(stationLng)
                ) {
                    return;
                }

                const distance =
                    Math.pow(
                        stationLat - trainLat,
                        2
                    ) +
                    Math.pow(
                        stationLng - trainLng,
                        2
                    );

                if (distance < closestDistance) {
                    closestDistance = distance;
                    foundIndex = index;
                }
            }
        );
    }

    if (foundIndex >= 0) {
        currentIndex = foundIndex;
    }

    /*
     * Only show current and upcoming stations
     */
    let remainingRoute =
        route.slice(currentIndex);

    if (
        remainingRoute.length === 0
    ) {

        remainingRoute = [
            {
                station:
                    live.current_station ||
                    "Current Station"
            }
        ];
    }

    /*
     * Calculate distances between stations
     */
    const segmentDistances = [];

    let totalRouteDistance = 0;

    for (
        let i = 0;
        i < remainingRoute.length - 1;
        i++
    ) {

        const distance =
            calculateDistanceBetweenRoutePoints(
                remainingRoute[i],
                remainingRoute[i + 1]
            );

        if (
            distance !== null &&
            Number.isFinite(distance) &&
            distance >= 0
        ) {

            segmentDistances.push(
                distance
            );

            totalRouteDistance += distance;

        } else {

            segmentDistances.push(1);

            totalRouteDistance += 1;
        }
    }

    /*
     * Calculate time remaining until
     * final predicted ETA
     */
    const etaDate =
        parseTimelineDate(
            predictedEta
        );

    let totalMinutes = 0;

    if (etaDate) {

        totalMinutes =
            Math.max(
                0,
                (
                    etaDate.getTime() -
                    Date.now()
                ) / 60000
            );
    }

    /*
     * Fallback when ETA cannot be parsed
     */
    if (
        !Number.isFinite(totalMinutes) ||
        totalMinutes <= 0
    ) {

        totalMinutes = 60;
    }

    let html = "";

    let accumulatedDistance = 0;

    /*
     * Compact by default. Expanded mode renders the complete route
     * inside the timeline's own scroll area.
     */
    const displayRoute =
        window.railEtaTimelineExpanded
            ? route
            : remainingRoute;

    displayRoute.forEach(
        function(station, index) {

            const originalIndex =
                window.railEtaTimelineExpanded
                    ? index
                    : currentIndex + index;

            const stationName =
                getRouteStationName(station) ||
                `Station ${originalIndex + 1}`;

            const stationCode =
                getRouteStationCode(station);

            const isPast =
                window.railEtaTimelineExpanded &&
                originalIndex < currentIndex;

            const isCurrent =
                originalIndex === currentIndex;

            const isDestination =
                originalIndex === route.length - 1;

            const isNext =
                originalIndex === currentIndex + 1 &&
                !isDestination;

            let stationLabel = "";

            if (isCurrent) {
                stationLabel = "CURRENT LOCATION";
            } else if (isNext) {
                stationLabel = "NEXT STATION";
            } else if (isDestination) {
                stationLabel = "DESTINATION";
            } else if (isPast) {
                stationLabel = "DEPARTED";
            } else {
                stationLabel = "UPCOMING";
            }

            let stationEta = null;

            if (etaDate && !isCurrent && !isPast) {

                const remainingIndex =
                    originalIndex - currentIndex;

                let distanceToStation = 0;

                for (
                    let distanceIndex = 0;
                    distanceIndex < remainingIndex;
                    distanceIndex++
                ) {
                    distanceToStation +=
                        segmentDistances[distanceIndex] || 0;
                }

                let progress = 0;

                if (totalRouteDistance > 0) {
                    progress =
                        distanceToStation /
                        totalRouteDistance;
                } else {
                    progress =
                        remainingRoute.length <= 1
                            ? 1
                            : remainingIndex /
                              (remainingRoute.length - 1);
                }

                progress = Math.min(
                    Math.max(progress, 0),
                    1
                );

                stationEta =
                    new Date(
                        Date.now() +
                        totalMinutes * progress * 60000
                    );
            }

            let distanceText = "";

            if (
                originalIndex >= currentIndex &&
                originalIndex < route.length - 1
            ) {
                const remainingIndex =
                    originalIndex - currentIndex;

                const distance =
                    segmentDistances[remainingIndex];

                if (
                    Number.isFinite(distance) &&
                    distance >= 0
                ) {
                    distanceText =
                        `${distance.toFixed(1)} km to next`;
                }
            }

            const shouldShowStation =
                window.railEtaTimelineExpanded ||
                remainingRoute.length <= 4 ||
                index <= 2 ||
                isDestination;

            if (!shouldShowStation) {
                return;
            }

            if (
                !window.railEtaTimelineExpanded &&
                isDestination &&
                remainingRoute.length > 4
            ) {
                const hiddenCount =
                    remainingRoute.length - 4;

                html += `
                    <div class="timeline-route-summary">
                        <span class="timeline-route-summary-line"></span>
                        <span>
                            ${hiddenCount} intermediate ${hiddenCount === 1 ? "station" : "stations"} hidden
                        </span>
                        <span class="timeline-route-summary-line"></span>
                    </div>
                `;
            }

            let itemClass = "timeline-item";

            if (isCurrent) itemClass += " current";
            if (isNext) itemClass += " next";
            if (isDestination) itemClass += " destination";
            if (isPast) itemClass += " departed";

            html += `
                <div class="${itemClass}">

                    <div class="timeline-dot"></div>

                    <div class="timeline-content">

                        <div class="timeline-station-row">

                            <div>
                                <h3 class="timeline-station-name">
                                    ${escapeTimelineHtml(stationName)}
                                    ${
                                        stationCode
                                            ? `
                                                <span class="timeline-station-code">
                                                    ${escapeTimelineHtml(stationCode)}
                                                </span>
                                            `
                                            : ""
                                    }
                                </h3>

                                <span class="timeline-current-badge">
                                    ${
                                        isCurrent
                                            ? "🚆 CURRENT LOCATION"
                                            : stationLabel
                                    }
                                </span>
                            </div>

                            <div class="timeline-eta">

                                <span class="timeline-eta-label">
                                    ${
                                        isCurrent
                                            ? "Current"
                                            : isPast
                                                ? "Status"
                                                : isDestination
                                                    ? "AI predicted arrival"
                                                    : "Expected arrival"
                                    }
                                </span>

                                <span class="timeline-eta-time">
                                    ${
                                        isCurrent
                                            ? "Now"
                                            : isPast
                                                ? "Departed"
                                                : stationEta
                                                    ? formatTimelineTime(stationEta)
                                                    : "—"
                                    }
                                </span>

                            </div>

                        </div>

                        <div class="timeline-details">

                            ${
                                distanceText
                                    ? `
                                        <span class="timeline-detail">
                                            ${distanceText}
                                        </span>
                                    `
                                    : ""
                            }

                            ${
                                isNext
                                    ? `
                                        <span class="timeline-detail">
                                            Train approaching next station
                                        </span>
                                    `
                                    : ""
                            }

                            ${
                                isDestination
                                    ? `
                                        <span class="timeline-detail">
                                            Final AI forecast
                                        </span>
                                    `
                                    : ""
                            }

                        </div>

                    </div>

                </div>
            `;
        }
    );

    html += `
        <div class="raileta-timeline-controls">
            <button
                type="button"
                class="raileta-show-all-stations-btn"
                onclick="toggleETATimelineStations()"
                aria-expanded="${window.railEtaTimelineExpanded ? "true" : "false"}"
            >
                ${
                    window.railEtaTimelineExpanded
                        ? "Show Less Stations"
                        : "Show All Stations"
                }
            </button>
        </div>
    `;

    timeline.innerHTML = html;

    /*
     * Update timeline timestamp
     */
    const status =
        document.getElementById(
            "timelineUpdateStatus"
        );

    if (status) {

        status.textContent =
            "Updated " +
            new Date().toLocaleTimeString();
    }
}


/* ---------------------------------------------------------
   Route station name
--------------------------------------------------------- */

function getRouteStationName(
    station
) {

    if (!station) {
        return "";
    }


    if (
        typeof station === "string"
    ) {
        return station;
    }


    return (
        station.name ||
        station.station_name ||
        station.stationName ||
        station.code ||
        station.station ||
        ""
    );
}


/* ---------------------------------------------------------
   Route station code
--------------------------------------------------------- */

function getRouteStationCode(
    station
) {

    if (!station ||
        typeof station === "string") {

        return "";
    }


    return (
        station.code ||
        station.station_code ||
        station.stationCode ||
        ""
    );
}


/* ---------------------------------------------------------
   Calculate distance between route points
--------------------------------------------------------- */

function calculateDistanceBetweenRoutePoints(
    first,
    second
) {

    if (!first || !second) {
        return null;
    }


    const lat1 =
        Number(
            first.latitude ??
            first.lat
        );

    const lon1 =
        Number(
            first.longitude ??
            first.lng ??
            first.lon
        );

    const lat2 =
        Number(
            second.latitude ??
            second.lat
        );

    const lon2 =
        Number(
            second.longitude ??
            second.lng ??
            second.lon
        );


    if (
        !Number.isFinite(lat1) ||
        !Number.isFinite(lon1) ||
        !Number.isFinite(lat2) ||
        !Number.isFinite(lon2)
    ) {

        return null;
    }


    const earthRadius = 6371;


    const dLat =
        (
            lat2 - lat1
        ) *
        Math.PI /
        180;


    const dLon =
        (
            lon2 - lon1
        ) *
        Math.PI /
        180;


    const a =
        Math.sin(dLat / 2) *
        Math.sin(dLat / 2) +

        Math.cos(
            lat1 *
            Math.PI /
            180
        ) *

        Math.cos(
            lat2 *
            Math.PI /
            180
        ) *

        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);


    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );


    return earthRadius * c;
}


/* ---------------------------------------------------------
   Date parser
--------------------------------------------------------- */

function parseTimelineDate(
    value
) {

    if (!value) {
        return null;
    }


    /*
     * Backend normally returns:
     *
     * YYYY-MM-DD HH:MM
     */

    const normalized =
        String(value)
            .replace(
                " ",
                "T"
            );


    const date =
        new Date(
            normalized
        );


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return null;
    }


    return date;
}


/* ---------------------------------------------------------
   Date formatter
--------------------------------------------------------- */

function formatTimelineDate(
    value
) {

    const date =
        parseTimelineDate(
            value
        );


    if (!date) {
        return value || "—";
    }


    return date.toLocaleString(
        [],
        {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
        }
    );
}


/* ---------------------------------------------------------
   Time formatter
--------------------------------------------------------- */

function formatTimelineTime(
    date
) {

    if (!date) {
        return "—";
    }


    return date.toLocaleTimeString(
        [],
        {
            hour: "2-digit",
            minute: "2-digit"
        }
    );
}


/* ---------------------------------------------------------
   Delay formatter
--------------------------------------------------------- */

function formatDelay(
    delay
) {

    const value =
        Number(delay);


    if (!Number.isFinite(value)) {
        return "—";
    }


    if (value <= 0) {
        return "On time";
    }


    return `+${Math.round(value)} min`;
}


/* ---------------------------------------------------------
   HTML escaping
--------------------------------------------------------- */

function escapeTimelineHtml(
    value
) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

// ==========================================
// UPDATE PREDICTION CHANGE TRACKING
// ==========================================

function updatePredictionTracking(data) {

    const prediction =
        data.prediction || {};

    const predictedEta =
        prediction.predicted_eta ||
        prediction.eta ||
        data.predicted_eta ||
        data.eta ||
        null;

    const totalDelay =
        Number(
            prediction.total_delay ?? 0
        );

    const now = new Date();

    /*
     * First prediction
     */
    if (previousPrediction === null) {

        previousPrediction = {
            eta: predictedEta,
            totalDelay: totalDelay
        };

        predictionTrackingCount = 1;

        setText(
            "previousPredictionEta",
            "—"
        );

        setText(
            "latestPredictionEta",
            predictedEta
                ? formatDateTime(predictedEta)
                : "ETA unavailable"
        );

        setText(
            "predictionEtaChange",
            "—"
        );

        setText(
            "predictionDelayChange",
            "—"
        );

    } else {

        /*
         * Calculate ETA change
         */
        let etaChangeMinutes = null;

        if (
            previousPrediction.eta &&
            predictedEta
        ) {

            const previousEtaTime =
                new Date(
                    previousPrediction.eta
                ).getTime();

            const latestEtaTime =
                new Date(
                    predictedEta
                ).getTime();

            if (
                !isNaN(previousEtaTime) &&
                !isNaN(latestEtaTime)
            ) {

                etaChangeMinutes =
                    (
                        latestEtaTime -
                        previousEtaTime
                    ) / (1000 * 60);
            }
        }

        /*
         * Calculate delay change
         */
        const delayChange =
            totalDelay -
            previousPrediction.totalDelay;

        /*
         * Previous ETA
         */
        setText(
            "previousPredictionEta",
            previousPrediction.eta
                ? formatDateTime(
                    previousPrediction.eta
                )
                : "ETA unavailable"
        );

        /*
         * Latest ETA
         */
        setText(
            "latestPredictionEta",
            predictedEta
                ? formatDateTime(
                    predictedEta
                )
                : "ETA unavailable"
        );

        /*
         * ETA change
         */
        if (
            etaChangeMinutes === null
        ) {

            setText(
                "predictionEtaChange",
                "Unavailable"
            );

        } else if (
            Math.abs(etaChangeMinutes) < 1
        ) {

            setText(
                "predictionEtaChange",
                "No change"
            );

        } else {

            const roundedEtaChange =
                Math.round(
                    Math.abs(
                        etaChangeMinutes
                    )
                );

            const direction =
                etaChangeMinutes > 0
                    ? "Later"
                    : "Earlier";

            setText(
                "predictionEtaChange",
                `${direction} by ${roundedEtaChange} min`
            );
        }

        /*
         * Delay change
         */
        if (
            Math.abs(delayChange) < 0.1
        ) {

            setText(
                "predictionDelayChange",
                "No change"
            );

        } else {

            const roundedDelayChange =
                Math.round(
                    Math.abs(
                        delayChange
                    )
                );

            const direction =
                delayChange > 0
                    ? "+"
                    : "-";

            setText(
                "predictionDelayChange",
                `${direction}${roundedDelayChange} min`
            );
        }

        predictionTrackingCount++;
    }

    /*
     * Last prediction update
     */
    setText(
        "lastPredictionUpdate",
        now.toLocaleTimeString(
            [],
            {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        )
    );

    /*
     * Number of predictions
     */
    setText(
        "predictionCount",
        predictionTrackingCount
    );

    /*
     * Determine prediction condition
     */
    let predictionState =
        "Prediction stable";

    if (
        previousPrediction !== null
    ) {

        const delayChange =
            totalDelay -
            previousPrediction.totalDelay;

        if (delayChange > 1) {

            predictionState =
                "Prediction worsening";

        } else if (delayChange < -1) {

            predictionState =
                "Prediction improving";
        }
    }

    /*
     * Update refresh status
     */
    setText(
        "predictionRefreshStatus",
        predictionState
    );

    /*
     * Activate refresh indicator
     */
    const refreshDot =
        document.getElementById(
            "predictionRefreshDot"
        );

    if (refreshDot) {

        refreshDot.classList.add(
            "active"
        );
    }

    /*
     * Add prediction to trend history
     */
    predictionTrendData.push({

        time: now,

        delay: totalDelay
    });

    /*
     * Keep latest 20 predictions
     */
    if (
        predictionTrendData.length > 20
    ) {

        predictionTrendData.shift();
    }

    /*
     * Update trend chart
     */
    updatePredictionTrendChart();

    /*
     * Store latest prediction
     * for the next refresh
     */
    previousPrediction = {

        eta: predictedEta,

        totalDelay: totalDelay
    };
}
// ==========================================
// PREDICTION TREND CHART
// ==========================================

function updatePredictionTrendChart() {

    const canvas =
        document.getElementById(
            "predictionTrendChart"
        );

    if (!canvas) {
        return;
    }

    if (
        typeof Chart === "undefined"
    ) {
        console.warn(
            "Chart.js is not loaded."
        );
        return;
    }

    const labels =
        predictionTrendData.map(
            item =>
                item.time.toLocaleTimeString(
                    [],
                    {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit"
                    }
                )
        );

    const values =
        predictionTrendData.map(
            item => item.delay
        );

    /*
     * Create chart once
     */
    if (!predictionTrendChart) {

        predictionTrendChart =
            new Chart(
                canvas.getContext("2d"),
                {
                    type: "line",

                    data: {
                        labels: labels,

                        datasets: [
                            {
                                label:
                                    "Predicted Total Delay",

                                data: values,

                                tension: 0.3,

                                fill: false,

                                pointRadius: 4,

                                pointHoverRadius: 6
                            }
                        ]
                    },

                    options: {
                        responsive: true,

                        maintainAspectRatio: false,

                        interaction: {
                            intersect: false,

                            mode: "index"
                        },

                        scales: {

                            x: {
                                title: {
                                    display: true,

                                    text:
                                        "Prediction Update"
                                }
                            },

                            y: {
                                beginAtZero: true,

                                title: {
                                    display: true,

                                    text:
                                        "Total Delay (minutes)"
                                }
                            }
                        }
                    }
                }
            );

        return;
    }

    /*
     * Update existing chart
     */

    predictionTrendChart.data.labels =
        labels;

    predictionTrendChart.data.datasets[0].data =
        values;

    predictionTrendChart.update();
}

async function loadDashboardStats() {

    try {

        const response =
            await fetch("/dashboard-stats");

        const data =
            await response.json();

        if (
            !response.ok ||
            data.success === false
        ) {
            throw new Error(
                data.error ||
                "Unable to load dashboard statistics."
            );
        }

        /*
         * Predictions Made
         */
        const predictionsElement =
            document.getElementById(
                "predictionsMade"
            );

        if (predictionsElement) {

            predictionsElement.textContent =
                data.total_predictions ?? 0;
        }

        /*
         * Live Trains Tracked
         */
        const trainsElement =
            document.getElementById(
                "liveTrainsTracked"
            );

        if (trainsElement) {

            trainsElement.textContent =
                data.trains_tracked ?? 0;
        }

        /*
         * Average Predicted Delay
         */
        const averageDelayElement =
            document.getElementById(
                "averagePredictedDelay"
            );

        if (averageDelayElement) {

            averageDelayElement.textContent =
                `${formatNumber(
                    data.average_predicted_delay ?? 0
                )} min`;
        }

    } catch (error) {

        console.error(
            "Dashboard statistics error:",
            error
        );
    }
}

document.addEventListener(
    "DOMContentLoaded",
    function() {

        loadDashboardStats();

    }
);


async function loadDashboardStats() {

    try {

        const response =
            await fetch("/dashboard-stats");

        const data =
            await response.json();

        if (
            !response.ok ||
            data.success === false
        ) {
            throw new Error(
                data.error ||
                "Unable to load dashboard statistics."
            );
        }

        /*
         * Total Predictions
         */
        setText(
            "totalPredictions",
            data.total_predictions ?? 0
        );

        /*
         * Average Delay
         */
        setText(
            "averageDelay",
            `${formatNumber(
                data.average_predicted_delay ?? 0
            )} min`
        );

        /*
         * Latest Train
         */
        setText(
            "latestTrain",
            data.latest_train || "—"
        );

        /*
         * Latest ETA
         */
        setText(
            "latestEta",
            data.latest_eta
                ? formatDateTime(
                    data.latest_eta
                )
                : "—"
        );

    } catch (error) {

        console.error(
            "Dashboard statistics error:",
            error
        );

    }
}

document.addEventListener(
    "DOMContentLoaded",
    function() {

        loadDashboardStats();

    }
);

setInterval(
    function() {

        loadDashboardStats();

    },
    30000
);

function updateAIExplanation(data) {

    const prediction =
        data.prediction || {};

    const explanation =
        prediction.explanation || {};

    const summary =
        document.getElementById(
            "aiExplanationSummary"
        );

    const factorsContainer =
        document.getElementById(
            "aiExplanationFactors"
        );

    if (!summary || !factorsContainer) {
        return;
    }

    /*
     * Update explanation summary
     */

    summary.textContent =
        explanation.summary ||
        "The AI prediction was generated from the available live train data.";


    /*
     * Get explanation factors
     */

    const factors =
        Array.isArray(
            explanation.factors
        )
            ? explanation.factors
            : [];


    /*
     * No factors available
     */

    if (!factors.length) {

        factorsContainer.innerHTML = `
            <div class="ai-explanation-empty">
                No prediction factor information
                is currently available.
            </div>
        `;

        return;
    }


    /*
     * Create factor cards
     */

    factorsContainer.innerHTML =
        factors.map(
            function(factor) {

                const importance =
                    Number(
                        factor.importance || 0
                    );

                const value =
                    Number(
                        factor.value || 0
                    );

                return `
                    <div
                        class="ai-factor-card"
                    >

                        <div
                            class="ai-factor-header"
                        >

                            <strong>
                                ${escapeHtml(
                                    factor.label ||
                                    factor.feature ||
                                    "Unknown factor"
                                )}
                            </strong>

                            <span>
                                ${importance.toFixed(2)}%
                            </span>

                        </div>

                        <div
                            class="ai-factor-bar"
                        >

                            <div
                                class="ai-factor-bar-fill"
                                style="
                                    width: ${Math.min(
                                        importance,
                                        100
                                    )}%;
                                "
                            ></div>

                        </div>

                        <div
                            class="ai-factor-value"
                        >
                            Current value:
                            <strong>
                                ${formatNumber(value)}
                            </strong>
                        </div>

                    </div>
                `;
            }
        )
        .join("");
}

function setLiveConnectionStatus(status) {

    const dot =
        document.querySelector(
            ".live-indicator-dot"
        );

    const statusElement =
        document.getElementById(
            "liveStatus"
        );

    if (!dot || !statusElement) {
        return;
    }


    if (status === "live") {

        dot.style.background =
            "#22c55e";

        dot.style.boxShadow =
            "0 0 0 4px rgba(34, 197, 94, 0.12)";

        statusElement.textContent =
            "Live";

    } else if (status === "updating") {

        dot.style.background =
            "#f59e0b";

        dot.style.boxShadow =
            "0 0 0 4px rgba(245, 158, 11, 0.12)";

        statusElement.textContent =
            "Updating";

    } else if (status === "unavailable") {

        dot.style.background =
            "#ef4444";

        dot.style.boxShadow =
            "0 0 0 4px rgba(239, 68, 68, 0.12)";

        statusElement.textContent =
            "Unavailable";
    }
}

/* =========================================================
   RAILETA FINAL UI + LIVE PREDICTION SAFETY PATCH
   Added without replacing existing prediction/map/ML logic.
   ========================================================= */

/*
 * Robust live-prediction button binding.
 * This works whether the button exists at initial DOM load
 * or is inserted later by the page.
 */
(function railEtaLivePredictionBinding() {
    function bindLivePredictionButton() {
        const button = document.getElementById("livePredictBtn");
        if (!button || button.dataset.railEtaBound === "true") {
            return;
        }

        button.dataset.railEtaBound = "true";
        button.type = "button";
        button.addEventListener("click", function(event) {
            event.preventDefault();
            event.stopPropagation();

            if (typeof window.handleLivePrediction === "function") {
                window.handleLivePrediction();
            } else if (typeof handleLivePrediction === "function") {
                handleLivePrediction();
            }
        });
    }

    function initialize() {
        bindLivePredictionButton();

        if (!window.__railEtaLiveButtonObserver) {
            const observer = new MutationObserver(bindLivePredictionButton);
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            window.__railEtaLiveButtonObserver = observer;
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();

/* Make the existing handler available to the HTML/UI layer too. */
window.handleLivePrediction = handleLivePrediction;

/*
 * Preserve the existing live prediction flow but make the
 * automatic refresh less aggressive for the external API.
 */
(function railEtaRefreshIntervalSafety() {
    window.RAIL_ETA_REFRESH_MS = 120000;
})();

/* =========================================================
   LIGHT / DARK THEME
   ========================================================= */
(function railEtaTheme() {
    const THEME_KEY = "raileta-theme";

    function getTheme() {
        try {
            const saved = localStorage.getItem(THEME_KEY);
            return saved === "dark" ? "dark" : "light";
        } catch (error) {
            return "light";
        }
    }

    function setTheme(theme) {
        const isDark = theme === "dark";

        document.documentElement.setAttribute(
            "data-theme",
            isDark ? "dark" : "light"
        );
        document.documentElement.classList.toggle("dark-theme", isDark);
        document.body.classList.toggle("dark-mode", isDark);
        document.body.classList.toggle("dark-theme", isDark);

        const button = document.getElementById("railEtaThemeToggle");
        if (button) {
            button.textContent = isDark ? "☀" : "☾";
            button.setAttribute(
                "aria-label",
                isDark ? "Switch to light mode" : "Switch to dark mode"
            );
            button.title = isDark ? "Switch to light mode" : "Switch to dark mode";
        }
    }

    function saveTheme(theme) {
        try {
            localStorage.setItem(THEME_KEY, theme);
        } catch (error) {
            // Theme still works for the current session.
        }
    }

    function createToggle() {
        if (document.getElementById("railEtaThemeToggle")) {
            setTheme(getTheme());
            return;
        }

        const button = document.createElement("button");
        button.id = "railEtaThemeToggle";
        button.className = "rail-eta-theme-toggle";
        button.type = "button";

        button.addEventListener("click", function() {
            const next =
                document.documentElement.getAttribute("data-theme") === "dark"
                    ? "light"
                    : "dark";

            setTheme(next);
            saveTheme(next);
        });

        const navbar = document.querySelector(".navbar .container, .navbar");
        if (navbar) {
            navbar.appendChild(button);
        } else {
            document.body.appendChild(button);
        }

        setTheme(getTheme());
    }

    function initialize() {
        setTheme(getTheme());
        createToggle();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();

/* =========================================================
   FOOTER
   ========================================================= */
(function railEtaFooter() {
    function createFooter() {
        if (document.getElementById("railetaFooter")) {
            return;
        }

        const footer = document.createElement("footer");
        footer.id = "railetaFooter";
        footer.className = "raileta-footer";

        footer.innerHTML = `
            <div class="raileta-footer-inner">
                <div class="raileta-footer-credit">
                    Designed &amp; Developed by Usman Gani Ansari
                </div>
                <div class="raileta-footer-team">
                    [Team Rocket] :
                    Team Members: Susmita, Kranti, Subham, Monalisa, Swati
                </div>
            </div>
        `;

        document.body.appendChild(footer);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", createFooter, { once: true });
    } else {
        createFooter();
    }
})();


/* =========================================================
   COMPACT ALL-STATIONS TIMELINE UI
========================================================= */
(function initializeRailEtaTimelineUI() {

    function addTimelineStyles() {
        if (document.getElementById("railEtaTimelineCompactStyles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "railEtaTimelineCompactStyles";

        style.textContent = `
            #etaTimeline {
                max-height: 520px;
                overflow-y: auto;
                overflow-x: hidden;
                scrollbar-width: thin;
            }

            .raileta-timeline-controls {
                display: flex;
                justify-content: center;
                padding: 16px 8px 4px;
                position: sticky;
                bottom: 0;
                background: inherit;
                z-index: 5;
            }

            .raileta-show-all-stations-btn {
                border: 1px solid #1769e0;
                background: #ffffff;
                color: #1769e0;
                border-radius: 10px;
                padding: 11px 22px;
                font: inherit;
                font-size: 14px;
                font-weight: 800;
                cursor: pointer;
                box-shadow: 0 6px 18px rgba(23,105,224,.10);
            }

            .raileta-show-all-stations-btn:hover {
                background: #1769e0;
                color: #ffffff;
            }

            .timeline-item.departed {
                opacity: .58;
            }

            body.dark-theme .raileta-show-all-stations-btn,
            body.dark-mode .raileta-show-all-stations-btn,
            html[data-theme="dark"] .raileta-show-all-stations-btn {
                background: #182335;
                color: #62b3ff;
                border-color: #4da8ff;
            }

            body.dark-theme .raileta-show-all-stations-btn:hover,
            body.dark-mode .raileta-show-all-stations-btn:hover,
            html[data-theme="dark"] .raileta-show-all-stations-btn:hover {
                background: #1769e0;
                color: #ffffff;
            }

            @media (max-width: 550px) {
                #etaTimeline {
                    max-height: 460px;
                }

                .raileta-show-all-stations-btn {
                    width: 100%;
                }
            }
        `;

        document.head.appendChild(style);
    }

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            addTimelineStyles
        );
    } else {
        addTimelineStyles();
    }

})();
