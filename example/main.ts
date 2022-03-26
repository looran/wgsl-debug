import { WGSL_debug } from 'wgsl-debug'
import { WGSL_debug_table } from 'wgsl-debug-table'

const VALUES_COUNT = 1000 * 1000
const BUF_UNIFORMS_SIZE = 1 + 1 // values_count + time
const BUF_UNIFORMS_SIZE_BYTES = BUF_UNIFORMS_SIZE * Uint32Array.BYTES_PER_ELEMENT;
const BUF_VALUES_SIZE = VALUES_COUNT * 2; // f32 * 2
const BUF_VALUES_SIZE_BYTES = BUF_VALUES_SIZE * Float32Array.BYTES_PER_ELEMENT;
const WORKGROUP_SIZE = 256;
const WORKGROUP_COUNT = 5;
const BINDGROUP_VALUES_NUM = 0;
const BINDGROUP_DEBUG_NUM = 1;
const PASS_MAX = 3000;
const DEBUG_ENTRIES_MAX = 4;

const SHADER_SRC = `struct uniform_t {
	values_count: u32;
	time: f32;
};

@group(0) @binding(0) var<uniform> uniforms: uniform_t;
@group(0) @binding(1) var<storage,read_write> c_values: array<vec2<f32>>;
@stage(compute) @workgroup_size(#WORKGROUP_SIZE)
fn compute(@builtin(local_invocation_id) lid: vec3<u32>,
	   @builtin(workgroup_id) wid: vec3<u32>,
	   @builtin(num_workgroups) numw: vec3<u32>) {
	var i = wid.x * #WORKGROUP_SIZEu + lid.x;
	for (; i < uniforms.values_count; i = i + #WORKGROUP_SIZEu * numw.x) {
		dbg_init(i);
		var v = c_values[i];
		dbg_f32m(0, v.x);		    // x
		dbg_f32m(1, v.y);		    // y
		dbg_f32m(2, uniforms.time);	    // time
		v = v * (1.0 + sin(uniforms.time / 1000.0) * 0.1);
		c_values[i] = v;
	}
}

@group(0) @binding(0) var<storage,read> v_values: array<vec2<f32>>;
@stage(vertex)
fn vertex(@builtin(vertex_index) vidx: u32) -> @builtin(position) vec4<f32> {
        var v = v_values[vidx];
        return vec4(v, 0.0, 1.0);
}

@stage(fragment)
fn fragment() -> @location(0) vec4<f32> {
        return vec4(1.0, 0.0, 0.0, 1.0);
}`.replace(/#WORKGROUP_SIZE/g, WORKGROUP_SIZE.toString());

var _device: GPUDevice;
var _cbindgroup: GPUBindGroup;
var _cpipeline: GPUComputePipeline;
var _rbindgroup: GPUBindGroup;
var _rpipeline: GPURenderPipeline;
var _debug: WGSL_debug;
var _debug_table: WGSL_debug_table;
var _context: GPUCanvasContext;
var _buf_uniforms: GPUBuffer;
var _buf_values: GPUBuffer;
var _presentation_format: GPUTextureFormat;
var _need_setup: boolean;
var _pass_n = 0;
var _compute_active = true;
var _debug_active = true;
var _stats: HTMLElement | null;
var _debug_uidmax = 2000;

async function main() {
	/* prepare WebGPU device and context */
	const gpu = navigator.gpu;
	if (!gpu) {
		err("your browser does not seem to support WebGPU");
	}
	var adapter = await gpu.requestAdapter();
	if (!adapter) {
		err("request for GPU adapter failed");
	}
	_device = await adapter.requestDevice();
	var canvas = <HTMLCanvasElement>document.getElementById("canvas");
	_context = canvas.getContext("webgpu");
	if (!_context) {
		err("could not get WebGPU context");
	}
	const pixelratio = window.devicePixelRatio || 1;
	const size = [canvas.clientWidth, canvas.clientHeight];
	const presentation_size = [ size[0] * pixelratio, size[1] * pixelratio ];
	_presentation_format = _context.getPreferredFormat(adapter);
	_context.configure({ device: _device, format: _presentation_format, size: presentation_size });
	document.getElementById("shader_src").innerHTML = SHADER_SRC.replace(/dbg/g, "<mark>dbg</mark>");
	_stats = document.getElementById("stats");

	/* create uniforms and values buffer */
	_buf_uniforms = _device.createBuffer({
		size: BUF_UNIFORMS_SIZE_BYTES,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
	})
	_buf_values = _device.createBuffer({
		size: BUF_VALUES_SIZE_BYTES,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
		mappedAtCreation: true });
	const values = new Float32Array(_buf_values.getMappedRange());
	const pos_angle = 2.0 * Math.PI / VALUES_COUNT;
	for (var n=0; n < VALUES_COUNT; n++) {
		values[n*2 + 0] = 0.5 * Math.cos(n * pos_angle);
		values[n*2 + 1] = 0.5 * Math.sin(n * pos_angle);
	}
	_buf_values.unmap();

	/* wgsl-debug: create debug instance */
	_debug = new WGSL_debug(BINDGROUP_DEBUG_NUM, DEBUG_ENTRIES_MAX);
	_debug_table = new WGSL_debug_table("debug-div");
	_debug.set_output(_debug_table);

	_need_setup = true;

	window.requestAnimationFrame(frame);
}

async function setup() {
	console.log(`setup debug_active=${_debug_active}`);
	/* wgsl-debug: add debug shader to shader_src */
	const shader_src = _debug.add_shader(SHADER_SRC, _debug_active);

	/* create shaders and pipelines */
	const shader = _device.createShaderModule({ code: shader_src });
        const infos = await shader.compilationInfo();
        if (infos.messages.length > 0) {
                err(`shader compilation has failed:\n` + infos.messages.map(m => `${m.lineNum}:${m.linePos} [${m.type}] ${m.message}`) );
        }
	_cpipeline = _device.createComputePipeline({
		compute: { module: shader, entryPoint: 'compute' } });
	_rpipeline = _device.createRenderPipeline({
		vertex: { module: shader, entryPoint: 'vertex', },
		fragment: { module: shader, entryPoint: 'fragment',
			    targets: [{ format: _presentation_format, }], },
		primitive: { topology: 'point-list', },
	});

	/* create bind groups */
	_cbindgroup = _device.createBindGroup({
		layout: _cpipeline.getBindGroupLayout(BINDGROUP_VALUES_NUM),
		entries: [
			{ binding: 0, resource: {buffer: _buf_uniforms} },
			{ binding: 1, resource: {buffer: _buf_values} },
		],
	});
	_rbindgroup = _device.createBindGroup({
		layout: _rpipeline.getBindGroupLayout(BINDGROUP_VALUES_NUM),
		entries: [ { binding: 0, resource: {buffer: _buf_values}} ],
	});

	/* wgsl-debug: create buffers and bindgroups */
	if (_debug_active) {
		_debug.setup(_device, _debug_uidmax);
		_debug.create_bindgroup(_cpipeline);
	}

	_need_setup = false;
}

async function frame() {
	if (_need_setup) {
		await setup();
	}

	if (_pass_n == 0 || _pass_n % 20 == 0) {
		_stats.innerText = `Points count: ${VALUES_COUNT}
Dispatch count: ${WORKGROUP_COUNT}
Compute pass: ${_pass_n}`;
	}

	const cmd = _device.createCommandEncoder();
	const time = performance.now();

	/* update uniforms */
	const uniforms = new ArrayBuffer(BUF_UNIFORMS_SIZE_BYTES);
	new Uint32Array(uniforms, 0, 1).set([VALUES_COUNT]);
	new Float32Array(uniforms, 4, 1).set([time]);
	_device.queue.writeBuffer(_buf_uniforms, 0, uniforms);

	/* compute pass */
	if (_compute_active) {
		const cpass = cmd.beginComputePass();
		cpass.setPipeline(_cpipeline);
		cpass.setBindGroup(0, _cbindgroup);
		if (_debug_active) {
			_debug.set_bindgroup(cpass); /* wgsl-debug: set debug bindgroup */
		}
		cpass.dispatch(WORKGROUP_COUNT);
		cpass.end();
		_pass_n++;
	}

	/* render pass */
	const texture_view = _context.getCurrentTexture().createView();
	const render_pass_descriptor: GPURenderPassDescriptor = {
		colorAttachments: [{
			view: texture_view,
			clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
			loadOp: 'clear',
			storeOp: 'store',
		}]
	};
	const rpass = cmd.beginRenderPass(render_pass_descriptor);
	rpass.setPipeline(_rpipeline);
	rpass.setBindGroup(0, _rbindgroup);
	rpass.draw(VALUES_COUNT, 1, 0, 0);
	rpass.end();

	/* wgsl-debug: fetch debug data */
	if (_debug_active) {
		_debug.fetch(cmd);
	}

	/* submit command buffer */
	const cmd_buffer = cmd.finish();
	_device.queue.submit([cmd_buffer]);

	/* wgsl-debug: process debug data */
	if (_debug_active) {
		await _debug.process();
	}
	
	if (_pass_n <= PASS_MAX) {
		window.requestAnimationFrame(frame);
	} else {
		_stats.innerText = _stats.innerText + "\nPASS_MAX reached";
		(document.getElementById("compute_active") as HTMLInputElement).checked = false;
	}
}

function cb_compute_active(e: Event) {
	const elm = (e.target as HTMLInputElement);
	_compute_active = elm.checked;
}

function cb_debug_active(e: Event) {
	const elm = (e.target as HTMLInputElement);
	_debug_active = elm.checked;
	_need_setup = true;
}

function cb_debug_visible() {
	const elm = document.getElementById("debug-div");
	elm.classList.toggle("hidden");
}

function cb_debug_uidmax_set() {
	const elm = document.getElementById("debug_uidmax") as HTMLInputElement;
	_debug_uidmax = Number(elm.value);
	_need_setup = true;
}

function err(msg: string) {
	alert(msg);
	throw new Error(msg);
}

document.addEventListener('DOMContentLoaded', main);
document.getElementById("compute_active").addEventListener('click', cb_compute_active);
document.getElementById("debug_active").addEventListener('click', cb_debug_active);
document.getElementById("debug_visible").addEventListener('click', cb_debug_visible);
document.getElementById("debug_uidmax_set").addEventListener('click', cb_debug_uidmax_set);
(document.getElementById("debug_uidmax") as HTMLInputElement).value = _debug_uidmax.toString();
(document.getElementById("debug_uidmax") as HTMLInputElement).max = VALUES_COUNT.toString();
