/* ---------------------------------------------------------------
Constants
--------------------------------------------------------------- */
ANGLE_LIMIT = Math.PI / 8;


/* ---------------------------------------------------------------
Globals
--------------------------------------------------------------- */

let map;

// Canvas variables
let canvas, ctx;

let windowLong;
let windowLat;
let slippyMode = true;

zoom = 0.2;

// Map variables
let boundB;
let boundL;
let boundT;
let boundR;


let nodes;
let ways;

let mapInitialized = false;
let singleSourceInitialized = false;

let sourceNode = null;
let sinkNode = null;

function toggleMode(){
    let btn = document.getElementById('main-button');
    btn.classList.toggle('slippy-mode')
    if (slippyMode){
        slippyMode = false;

        mapLocationSelected();

            map._container.style.opacity = 0;
            map._container.style.pointerEvents = 'none';
    } else {
        slippyMode = true;

        map._container.style.opacity = 1;
        map._container.style.pointerEvents = 'auto';
    }
}

function mapLocationSelected(){

    let mapLocation = map.getBounds();

    boundB = mapLocation._southWest.lat;
    boundL = mapLocation._southWest.lng;
    boundT = mapLocation._northEast.lat;
    boundR = mapLocation._northEast.lng;

    getMapData().then(() => {

        // FIXME: since the simplification works in place which is kinda stupid
        // if we run it multiple times we get better results each time
        simplifyMapData();
        simplifyMapData();
        simplifyMapData();
        simplifyMapData();
        simplifyMapData();

        initializeSingleSource();
        drawMap();
        touchMap();

    });
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    //TODO: resizing canvas can mean that we have to re-query the map data
}

window.onload = async () => {
    canvas = document.querySelector("#main-canvas");
    ctx = canvas.getContext("2d");

    resizeCanvas();

    map = L.map('map').setView([51.505, -0.09], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    canvas.onclick = (event) => {
        if (slippyMode)
            return;

        if (!mapInitialized)
            return;

        let mousePos = [event.clientX, event.clientY];
        let closestNode = null;
        let closestDistance = Infinity;

        ways.forEach((way) => {
            way.nodes.forEach((node) => {
                const nodeObj = nodes.get(node)

                const distance = dist(...mousePos, ...worldToCanvas(nodeObj.lon, nodeObj.lat));
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestNode = nodeObj;
                }
            });
        });

        if (closestNode == null)
            return;

        if (sourceNode == null) {
            sourceNode = closestNode;
        } else if (sinkNode == null) {
            sinkNode = closestNode;

            shortestPath(sourceNode, sinkNode, (node) => {
                return dist(node.lon, node.lat, sinkNode.lon, sinkNode.lat);
            });
        } else {
            sourceNode = null;
            sinkNode = null;
            initializeSingleSource();
        }
    };
};

window.onresize = resizeCanvas;

class Node {
    constructor(id, lat, lon) {
        // Map info
        this.id = id;
        this.lat = lat;
        this.lon = lon;

        // Graph info
        this.pred = null;
        this.g = Infinity; // Distance from start
        this.h = 0; // Heuristic value
        this.edges = [];

        // Visualization info
        this.touched = false;
        this.lastTouched = null;
        this.completed = false;
        this.onSolution = false;
    }

    get f() {
        return this.g + this.h;
    }
}

class Way {
    constructor(id, nodes) {
        this.id = id;
        this.nodes = nodes;
    }
}

function getMapData() {
    return new Promise((resolve, reject) => {

        nodes = new Map();
        ways = [];

        const mapRequest = new XMLHttpRequest();
        mapRequest.open(
            "POST",
            "https://overpass-api.de/api/interpreter",
        )

        mapRequest.onreadystatechange = () => {
            if (mapRequest.readyState != 4) { //FIXME add error handling
                return;
            }

            const mapDataString = mapRequest.response;

            const parser = new DOMParser();
            const mapData = parser.parseFromString(mapDataString, "application/xml");

            Array.from(mapData.documentElement.children).forEach((elm) => {

                if (elm.tagName == 'node') {
                    nodes.set(Number(elm.id), new Node(Number(elm.id), Number(elm.getAttribute('lat')), Number(elm.getAttribute('lon'))));
                } else if (elm.tagName == 'way') {

                    if (elm.children.length <= 1)
                        return; // early return for any ways with one or zero nodes (invalid)

                    let _nodes = [];
                    let prevNode = null
                    for (let i = 0; i < elm.children.length; i++) {
                        const child = elm.children[i];
                        if (child.tagName == 'nd') {

                            const ref = Number(child.getAttribute('ref'));

                            // Store node ref in way object
                            _nodes.push(ref);

                            // Save graph edges in node
                            const node = nodes.get(ref);

                            if (prevNode != null) {
                                node.edges.push(prevNode.id);
                                prevNode.edges.push(ref);
                            }

                            prevNode = node;
                        }
                    }
                    ways.push(new Way(Number(elm.id), _nodes));
                }
            });

            mapInitialized = true;
            singleSourceInitialized = true;

            resolve();
        }

        mapRequest.send(
            `data=(
            way["highway"~"motorway|trunk|primary|secondary"]
            (${boundB},${boundL},${boundT},${boundR});
            );

            (
                ._;
                node(w);
            );
            out skel;
        `
        );
    });

}

function simplifyMapData() {
    console.log("Nodes before: ", nodes.size);

    // FIXME: make this not run in place. many nodes are skipped
    // since the arrays are shrinking as we delete items
    for (let i = 0; i < ways.length; i++) {
        const way = ways[i];

        // Loop over all nodes in way except for starting and ending
        // node since we cannot remove those
        for (let j = 1; j < way.nodes.length - 1; j++) {
            const node = nodes.get(way.nodes[j]);

            if (!node) // node has already been removed
                continue;

            // If a node is at the start, end or is
            // a junction it's edges will be != to 2
            if (node.edges.length != 2)
                continue;

            // Calculate the angle at this node
            let sibling1 = nodes.get(node.edges[0]);
            let sibling2 = nodes.get(node.edges[1]);

            let vec1 = [sibling1.lon - node.lon, sibling1.lat - node.lat];
            let vec2 = [sibling2.lon - node.lon, sibling2.lat - node.lat];

            // Calculate angle between vectors via dot product
            let dot = vec1[0] * vec2[0] + vec1[1] * vec2[1];

            let mag1 = Math.sqrt(vec1[0] * vec1[0] + vec1[1] * vec1[1]);
            let mag2 = Math.sqrt(vec2[0] * vec2[0] + vec2[1] * vec2[1]);

            let angle = Math.acos(dot / (mag1 * mag2));

            if (angle > Math.PI - ANGLE_LIMIT) {
                // Remove this node from the graph
                let edge1 = sibling1.edges.indexOf(node.id);
                let edge2 = sibling2.edges.indexOf(node.id);

                sibling1.edges.splice(edge1, 1);
                sibling2.edges.splice(edge2, 1);

                // Add an edge between the siblings
                sibling1.edges.push(sibling2.id);
                sibling2.edges.push(sibling1.id);

                // Remove this node from the nodes map
                nodes.delete(node.id);

                // Remove this node from the way object
                way.nodes.splice(j, 1);
            }
        }
    }

    console.log("Nodes after: ", nodes.size);
}

function worldToCanvas(lon, lat) {
    // FIXME account for longitude discontinuity...
    let coords = [
        ((lon - boundL) / (boundR - boundL)) * canvas.width,
        ((lat - boundT) / (boundB - boundT)) * canvas.height // Canvas has 0,0 in top left corner so top and bottom bounds are swapped
    ];

    return coords;
}

async function drawMap() {

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if(slippyMode){
        return;
    }
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    const now = Date.now();

    for (let i = 0; i < ways.length; i++) {
        const way = ways[i];
        const start = nodes.get(way.nodes[0]);

        if (!start) { //FIXME: not sure when this happens and what to do about it
            return;
        }


        ctx.beginPath();
        ctx.moveTo(...worldToCanvas(start.lon, start.lat));

        for (let idx = 1; idx < way.nodes.length; idx++) {

            const node = nodes.get(way.nodes[idx]);

            if (!node) { //FIXME: not sure when this happens and what to do about it
                continue;
            }

            let brightness;
            brightness = node.lastTouched == null ? 0 : (1 - Math.min((now - node.lastTouched) / 800, 0.85)) * 255;
            if (node.completed && brightness < 120) {
                brightness = 120;
            }

            ctx.strokeStyle = `rgba(${brightness},${brightness},${brightness},1)`;

            ctx.lineTo(...worldToCanvas(node.lon, node.lat));
        }

        ctx.stroke();
    }

    // Draw final path if found
    if (sinkNode && sinkNode.onSolution == true) {
        let node = sinkNode;
        ctx.beginPath();
        ctx.moveTo(...worldToCanvas(node.lon, node.lat));
        while (node.pred != null) {
            node = node.pred;
            ctx.lineTo(...worldToCanvas(node.lon, node.lat));
        }
        ctx.shadowColor = "white";
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.shadowBlur = 10;
        ctx.strokeStyle = "white";
        ctx.stroke();
    }

    // Draw Source and Sink nodes
    if (sourceNode) {
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.arc(...worldToCanvas(sourceNode.lon, sourceNode.lat), 10, 0, 2 * Math.PI);
        ctx.fill();
    }

    if (sinkNode) {
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.arc(...worldToCanvas(sinkNode.lon, sinkNode.lat), 10, 0, 2 * Math.PI)
        ctx.fill();
    }

    requestAnimationFrame(drawMap);
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms) });
}

function dist(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
}

let flameFront = [];
function touchMap() {

    // Pick a random starting way
    let startIdx = Math.round(Math.random() * ways.length - 1);
    let startNode = nodes.get(ways[startIdx].nodes[0]);

    // Add that node to the flame front
    flameFront.push(startNode.id);

    spreadFront();
}

async function spreadFront() {
    const now = Date.now();

    for (let i = 0; i < flameFront.length; i++) {
        const node = nodes.get(flameFront[i]);
        node.lastTouched = now;
        node.touched = true;

        flameFront.splice(i, 1);

        for (let j = 0; j < node.edges.length; j++) {
            if (nodes.get(node.edges[j]).touched == false)
                flameFront.push(node.edges[j]);
        }
    }

    requestAnimationFrame(spreadFront);
}

function initializeSingleSource() {
    ways.forEach((way) => {
        way.nodes.forEach((node) => {
            const nodeObj = nodes.get(node);
            nodeObj.pred = null;
            nodeObj.g = Infinity;
            nodeObj.onSolution = false;
            nodeObj.completed = false;
        });
    });
}

function relax(u, v, w) {
    let wUV = w(u, v);
    if (v.g > u.g + wUV) {
        v.g = u.g + wUV;
        v.pred = u;
    }
}

const PATH_SPEED = 10;
async function shortestPath(source, sink, heuristic) {
    console.log('finding path');
    if (!mapInitialized) {
        throw Error("Cannot compute shortest path before map is initialized");
    }

    source.g = 0;

    let open = [];
    let closed = [];

    open.push(source);

    while (open.length != 0) {
        let q = null;
        let qi = 0;
        for (let i = 0; i < open.length; i++) {
            const node = open[i];
            if (q == null || node.f < q.f) {
                q = node;
                qi = i;
            }
        }

        open.splice(qi, 1);
        closed.push(q);
        q.completed = true;

        for (let i = 0; i < q.edges.length; i++) {
            const node = nodes.get(q.edges[i]);

            if (node == sink) {
                // Search complete
                sink.pred = q;
                open = [];
                break;
            } else {

                if (closed.includes(node))
                    continue;

                let _g = q.g + dist(q.lon, q.lat, node.lon, node.lat);

                if (!open.includes(node)) {
                    open.push(node);
                    node.lastTouched = Date.now();
                    node.h = heuristic(node);
                    node.g = _g;
                    node.pred = q;
                }

                else if (_g < node.g) {
                    node.g = _g;
                    node.pred = q;
                }
            }
        }

        if(Math.floor(Math.random() * PATH_SPEED) == 0 )
            await sleep(1);
    }

    console.log(sink);
    if (sink.pred != null) {
        let node = sink;
        while (node.pred != null) {
            node.onSolution = true;
            node = node.pred;
        }
    }
}