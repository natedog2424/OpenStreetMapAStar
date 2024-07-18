
/* ---------------------------------------------------------------
Globals
--------------------------------------------------------------- */

// Canvas variables
let canvas, ctx;

windowLong = 12.48;
windowLat = 41.89;

zoom = 0.1;

// Map variables
let boundB = windowLat;
let boundL = windowLong;
let boundT = windowLat;
let boundR = windowLong;



let nodes, ways;

let mapInitialized = false;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    //TODO: resizing canvas can mean that we have to re-query the map data
}

window.onload = async () => {
    canvas = document.querySelector("#main-canvas");
    ctx = canvas.getContext("2d");

    resizeCanvas();

    const aspect = canvas.width/canvas.height;

    boundT += zoom/2;
    boundB -= zoom/2;
    boundR += (zoom/2 * aspect);
    boundL -= (zoom/2 * aspect);

    getMapData().then(() => {
        
        drawMap();
        touchMap();

    });

    canvas.onclick = (event) => {
        let mousePos = [event.clientX, event.clientY];
        let closestNode = null;
        let closestDistance = Infinity;

        flameFront = [];
        ways.forEach((way) => {
            way.nodes.forEach((node) => {
                const nodeObj = nodes.get(node)
                nodeObj.touched = false;
                
                const distance = canvasDistance(...mousePos, ...worldToCanvas(nodeObj.lon, nodeObj.lat));
                if(distance < closestDistance){
                    closestDistance = distance;
                    closestNode = nodeObj;
                }
            });
        });

        if (closestNode == null) return;

        flameFront.push(closestNode.id);
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
        this.dist = Infinity;
        this.edges = [];

        // Visualization info
        this.touched = false;
        this.lastTouched = null;
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

            nodes = new Map();
            ways = [];

            Array.from(mapData.documentElement.children).forEach((elm) => {

                if (elm.tagName == 'node') {
                    nodes.set(Number(elm.id), new Node(Number(elm.id), Number(elm.getAttribute('lat')), Number(elm.getAttribute('lon'))));
                } else if (elm.tagName == 'way') {

                    if(elm.children.length <= 1)
                        return; // early return for any ways with one or zero nodes (invalid)
                    
                    let _nodes = [];
                    let prevNode = null
                    for(let i = 0; i < elm.children.length; i++){
                        const child = elm.children[i];
                        if (child.tagName == 'nd') {

                            // dumb optimization strategy, only keep every n nodes other than the start and end node
                            // TODO: try other techniques like angle based or length based
                            // FIXME: DONT USE INDEX BECAUSE THERE ARE NON-ND TAGS!!!
                            if(i != 0 && i != elm.children.length - 1){
                                if(i % 1 != 0)
                                    continue;
                            }

                            const ref = Number(child.getAttribute('ref'));

                            // Store node ref in way object
                            _nodes.push(ref);

                            // Save graph edges in node
                            const node = nodes.get(ref);
                            
                            if(prevNode != null){
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
    ctx.lineWidth = 3;
    //ctx.strokeStyle = '#1c1c1b';
    ctx.strokeStyle = 'black';
    const now = Date.now();
    
    for(let i = 0; i < ways.length; i++) {
        const way = ways[i];
        const start = nodes.get(way.nodes[0]);

        if(!start){ //FIXME: not sure when this happens and what to do about it
            return;
        }


        ctx.beginPath();
        ctx.moveTo(...worldToCanvas(start.lon, start.lat));

        for (let idx = 1; idx < way.nodes.length; idx++) {
            
            const node = nodes.get(way.nodes[idx]);

            if(!node){ //FIXME: not sure when this happens and what to do about it
                continue;
            }
            
            const brightness = node.lastTouched == null? 0 : (1 - Math.min((now - node.lastTouched ) / 1000, 0.9)) * 255;
            ctx.strokeStyle = `rgba(${brightness},${brightness},${brightness},1)`;

            ctx.lineTo(...worldToCanvas(node.lon, node.lat));
        }

        ctx.stroke();
    }

    requestAnimationFrame(drawMap);
}

function sleep(ms){
    return new Promise((resolve) => { setTimeout(resolve, ms) });
}

function canvasDistance(x1, y1, x2, y2){
    return Math.sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));
}

let flameFront = [];
function touchMap(){

    // Pick a random starting way
    let startIdx = Math.round(Math.random() * ways.length - 1);
    let startNode = nodes.get(ways[startIdx].nodes[0]);

    // Add that node to the flame front
    flameFront.push(startNode.id);

    spreadFront();
}

async function spreadFront(){
    const now = Date.now();

    for(let i = 0; i < flameFront.length; i++){
        const node = nodes.get(flameFront[i]);
        node.lastTouched = now;
        node.touched = true;

        flameFront.splice(i, 1);

        for(let j = 0; j < node.edges.length; j++){
            if(nodes.get(node.edges[j]).touched == false)
                flameFront.push(node.edges[j]);
        }
    }

    requestAnimationFrame(spreadFront);
}