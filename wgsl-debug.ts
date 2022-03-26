/* wgsl-debug - Typescript library providing print-like function to WGSL shader
 * 2022, Laurent Ghigonis <ooookiwi@gmail.com> */

/// <reference types="@webgpu/types" />

export type WGSL_debug_entry = {
	value: number,
	type: number,
	mark: number,
	processed: boolean,	// for output optimisations
}

export class WGSL_debug {
	public static readonly BUF_HEADER_SIZE = 16;
	public static readonly BUF_HEADER_SIZE_BYTES = Uint32Array.BYTES_PER_ELEMENT * WGSL_debug.BUF_HEADER_SIZE;
	public static readonly BUF_UNIT_HEADER_SIZE = 1; /* count */
	public static readonly BUF_UNIT_ENTRIES_COUNT_DEFAULT = 20;
	public static readonly BUF_ENTRY_SIZE = 3; /* type + value + mark */
	public static readonly BUF_ENTRY_TYPE_U32 = 1;
	public static readonly BUF_ENTRY_TYPE_I32 = 2;
	public static readonly BUF_ENTRY_TYPE_F32 = 3;
	public static readonly BUF_ENTRY_MARK_UNSET = 999999;
	public static readonly HANG_DETECT_LIMIT = 500;		// hang detection time (ms) for current op
	public static readonly HANG_DETECT_RESOLUTION = 100;	// counter increment before looking at time
	public static readonly SHADER_INACTIVE = `fn dbg_init(unit_id: u32) {}

fn dbg_u32(val: u32) {}
fn dbg_i32(val: i32) {}
fn dbg_f32(val: f32) {}
fn dbg_32(val: u32, vtype: u32) {}

fn dbg_u32m(mark: i32, val: u32) {}
fn dbg_i32m(mark: i32, val: i32) {}
fn dbg_f32m(mark: i32, val: f32) {}
fn dbg_32m(mark: i32, val: f32, vtype: i32) {}`;
	private shader_active = () => `@group(${this.bindgroup_num}) @binding(0) var<storage,read_write> _dbg: array<u32>;

var<private> _dbg_unit: u32;

fn dbg_init(uid: u32) {
	/* initialize debug unit for this uid */
	_dbg_unit = ${WGSL_debug.BUF_HEADER_SIZE}u + uid*${this.buf_unit_size()}u;
	_dbg[_dbg_unit] = 0u; // entries count
}

fn dbg_32m(mark: i32, val: u32, vtype: i32) {
	/* limit entries count, but still store the total number of calls */
	var entry_count = _dbg[_dbg_unit];
	_dbg[_dbg_unit] = entry_count + 1u;
	if (entry_count == ${this.buf_unit_entries_count}u) {
		return;
	}

	/* store data in a new debug unit entry */
	var entry_off = _dbg_unit + 1u + entry_count * ${WGSL_debug.BUF_ENTRY_SIZE}u;
	_dbg[entry_off] = u32(vtype);
	_dbg[entry_off + 1u] = val;
	_dbg[entry_off + 2u] = u32(mark);
}

fn dbg_u32m(mark: i32, val: u32) { dbg_32m(mark, val, ${WGSL_debug.BUF_ENTRY_TYPE_U32}); }
fn dbg_i32m(mark: i32, val: i32) { dbg_32m(mark, bitcast<u32>(val), ${WGSL_debug.BUF_ENTRY_TYPE_I32}); }
fn dbg_f32m(mark: i32, val: f32) { dbg_32m(mark, bitcast<u32>(val), ${WGSL_debug.BUF_ENTRY_TYPE_F32}); }
fn dbg_32(val: u32, vtype: i32) { dbg_32m(${WGSL_debug.BUF_ENTRY_MARK_UNSET}, val, vtype); }
fn dbg_u32(val: u32) { dbg_u32m(${WGSL_debug.BUF_ENTRY_MARK_UNSET}, val); }
fn dbg_i32(val: i32) { dbg_i32m(${WGSL_debug.BUF_ENTRY_MARK_UNSET}, val); }
fn dbg_f32(val: f32) { dbg_f32m(${WGSL_debug.BUF_ENTRY_MARK_UNSET}, val); }`;
	private device: GPUDevice;
	private buf_unit_size = () => WGSL_debug.BUF_UNIT_HEADER_SIZE + this.buf_unit_entries_count * WGSL_debug.BUF_ENTRY_SIZE;
	private buf_unit_size_bytes = () => Uint32Array.BYTES_PER_ELEMENT * this.buf_unit_size();
	private bindgroup: GPUBindGroup;
	private bindgroup_num: number;
	private buf_unit_entries_count: number;
	private unit_count: number;
	private buf_size: number;
	private dstbuf: GPUBuffer;
	private hang_detect_op: string;		// current operation name
	private hang_detect_start: number;	// current operation start time
	private hang_detect_counter: number;	// current operation iteration
	private hang_detect_resolution: number;	// current operation iterations before checking time
	public record: Array<Array<Array<WGSL_debug_entry>>>; /* [pass: [uid: [entry,...] ] ] */
	public pass_n: number;
	public marks: Array<string>;
	public buf: GPUBuffer;
	public output: WGSL_debug_output;

	public constructor(bindgroup_num: number, buf_unit_entries_count?: number) {
		this.bindgroup_num = bindgroup_num;
		this.buf_unit_entries_count = (buf_unit_entries_count === undefined) ? WGSL_debug.BUF_UNIT_ENTRIES_COUNT_DEFAULT : buf_unit_entries_count;
		this.record = new Array();
		this.pass_n = 0;
	}

	public set_output(output: WGSL_debug_output) {
		output.attach(this);
		this.output = output;
	}

	public add_shader(src: string, active: boolean) {
		if (active) {
			if (src.search(/^[ \t]*dbg_init/m) < 0) {
				alert("your shader does not contain any dbg_init() call, debug will not work properly");
			}
		}
		var debug_src = active ? this.shader_active() : WGSL_debug.SHADER_INACTIVE;

		/* read marks names from comments of dbg_*32m calls */
		this.marks = new Array();
		const dbgm_calls = src.matchAll(/^[ \t]*dbg_[uif]?32m[ \t]*\([ \t]*(?<value>[0-9]+)[^;]*;[ \t]*(\/\/|\/\*)(?<comment>.*)/mg);
		for (const call of dbgm_calls) {
			const value: number = Number(call.groups['value']);
			const comment: string = call.groups['comment'].trim();
			this.marks[value] = comment;
		}
		console.log(`WGSL_debug add_shader ${JSON.stringify(this.marks)}`);

		return debug_src + "\n" + src;
	}

	public setup(device: GPUDevice, unit_count: number) {
		console.log("WGSL_debug setup");
		this.device = device;
		this.unit_count = unit_count;
		this.buf_size = WGSL_debug.BUF_HEADER_SIZE_BYTES + unit_count * this.buf_unit_size_bytes();
		console.log(`WGSL_debug unit_count=${unit_count} buf_size=${this.buf_size}`);
		/* create buffer for GPU shader to write */
		if (this.buf) {
			this.buf.destroy();
		}
		this.buf = device.createBuffer({
			size: this.buf_size,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		});
		/* create buffer for data retrieval to CPU */
		if (this.dstbuf) {
			this.dstbuf.destroy();
		}
		this.dstbuf = device.createBuffer({
			size: this.buf_size,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
		});
		this.record = new Array();
		this.pass_n = 0;
		if (this.output) {
			this.output.reset();
		} else {
			console.log("WGSL_debug output format: <debug_header>\n"
				+ `<global_invoke_id> <debug_call_n> [<record_count>] <pass_last-${this.buf_unit_entries_count}...last>`);
		}
	}

	public create_bindgroup(pipeline: GPUComputePipeline) {
		this.bindgroup = this.device.createBindGroup({
			layout: pipeline.getBindGroupLayout(this.bindgroup_num),
			entries: [ { binding: 0, resource: {buffer: this.buf } } ],
		});
	}

	public set_bindgroup(pass: GPUComputePassEncoder) {
		pass.setBindGroup(this.bindgroup_num, this.bindgroup);
	}

	public fetch(cmd: GPUCommandEncoder) {
		cmd.copyBufferToBuffer(this.buf, 0, this.dstbuf, 0, this.buf_size);
	}

	public async process(cb_data?: Function) {
		await this.dstbuf.mapAsync(GPUMapMode.READ);
		const buf = this.dstbuf.getMappedRange();
		const buf_u32 = new Uint32Array(buf);
		const buf_i32 = new Int32Array(buf);
		const buf_f32 = new Float32Array(buf);
		var pass_data: Array<Array<WGSL_debug_entry>>; // [uid: [entry,...] ]
		this.hang_detect("reset");

		/* read retrieved data to pass_data */
		pass_data = Array.from(Array(this.unit_count), () => new Array());
		for (var uid=0; uid < this.unit_count; uid+=1) { /* for each unit */
			if (this.hang_detect("process")) {
				break;
			}
			const unit_off = WGSL_debug.BUF_HEADER_SIZE + uid * this.buf_unit_size();
			const entry_count = buf_u32[unit_off];
			if (entry_count > 0) {
				if (entry_count > this.buf_unit_entries_count) {
					console.warn(`WGSL debug: ${entry_count} debug calls where made from unit_id=${uid}, but only the first ${this.buf_unit_entries_count} where recorded\n`
						+ 'Consider increasing buf_unit_entries_count.');
				}
				for (var entry=0; entry < Math.min(entry_count, this.buf_unit_entries_count); entry++) { /* for each debug entry of this unit */
					/* read value with appropriate type, and mark */
					const entry_off = unit_off + WGSL_debug.BUF_UNIT_HEADER_SIZE + entry * WGSL_debug.BUF_ENTRY_SIZE;
					const type = buf_u32[entry_off];
					var value = -1;
					if (type == WGSL_debug.BUF_ENTRY_TYPE_U32) {
						value = buf_u32[entry_off + 1];
					} else if (type == WGSL_debug.BUF_ENTRY_TYPE_I32) {
						value = buf_i32[entry_off + 1];
					} else if (type == WGSL_debug.BUF_ENTRY_TYPE_F32) {
						value = buf_f32[entry_off + 1];
					}
					var mark = buf_u32[entry_off + 2];
					/* append value to pass_data */
					pass_data[uid].push(<WGSL_debug_entry>{
						value: value,
						type: type,
						mark: mark
					});
				}
			}
		}

		/* add pass_data to record */
		this.record.push(pass_data);

		/* user callback and/or print data */
		var console_log = true;
		if (this.output) {
			console_log = false;
			this.output.update();
		}
		if (cb_data) {
			console_log = cb_data(this.pass_n, pass_data, this.record);
		}
		if (console_log) {
			console.log(`WGSL_debug ${buf_u32.slice(0, WGSL_debug.BUF_HEADER_SIZE).toString()}`);
			var s = "";
			pass_data.forEach((entries, uid) => {
				s += `${uid} [${entries.length}] ${entries}\n`;
			});
			console.log(s)
		}

		this.dstbuf.unmap();
		this.pass_n++;
	}

	public clear_processed() {
		this.record.forEach((pass) => {
			pass.forEach((entries) => {
				entries.forEach((entry) => {
					entry.processed = false;
				});
			});
		});
	}

	public hang_detect(current_op: string, resolution?: number): boolean {
		if (current_op != this.hang_detect_op) {
			this.hang_detect_op = current_op;
			this.hang_detect_start = Date.now();
			this.hang_detect_counter = 0;
			this.hang_detect_resolution = (resolution) ? resolution : WGSL_debug.HANG_DETECT_RESOLUTION;
		} else {
			this.hang_detect_counter++;
			if (this.hang_detect_counter % this.hang_detect_resolution == 0) {
				const now = Date.now();
				if (now - this.hang_detect_start > WGSL_debug.HANG_DETECT_LIMIT) {
					console.warn(`WGSL_debug hang detected in '${current_op}' after ${this.hang_detect_counter} iterations (${WGSL_debug.HANG_DETECT_LIMIT}ms), interrupting operation`);
					this.hang_detect_op = null;
					return true;
				}
			}
		}
		return false;
	}
}

export abstract class WGSL_debug_output {
	public debug: WGSL_debug;

	public constructor() {}
	public attach(debug: WGSL_debug) {
		console.log("WGSL_debug output attach");
		this.debug = debug;
	}
	public abstract reset(): void;
	public abstract update(): void;
}

