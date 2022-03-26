/* wgsl-debug-table - Extension for wgsl-debug to display debugging data in HTML table
 * 2022, Laurent Ghigonis <ooookiwi@gmail.com> */

import { WGSL_debug, WGSL_debug_output } from 'wgsl-debug'

/* html table column informations */
type html_col_info = {
	maxlen: number;		// maximum len for text in this column
	mark: number;		// mark number in this column
	dirty_maxlen: boolean;	// maxlen has been changed
	width: number;		// width in pixel of this column
}

type WGSL_debug_table_conf = {
	selected_pass: number;	// currently selected pass
	pass_range: number;	// number of other pass we should display in same cell
	live: boolean;		// live mode active
}

export class WGSL_debug_table extends WGSL_debug_output {
	private static readonly COL_WIDTH_ADJUST = 3;
	private static readonly MIN_UPDATE_INTERVAL = 100; // ms
	private conf: WGSL_debug_table_conf;
	private scroll: HTMLTableElement;
	private table: HTMLTableElement;
	private timeline: HTMLInputElement;
	private timelineval: HTMLInputElement;
	private passcount: HTMLInputElement;
	private timelinelive: HTMLInputElement;
	private passrange: HTMLInputElement;
	private row_height: number;		// calculated row height
	private col: Array<html_col_info>;	// informations for each table columns
	private last_update: number;		// time of last update
	private update_timeout: number;		// delayed update timeout, to avoid updating table too fast
	private processed: Array<boolean>;	// processing state of each pass, to avoid reprocess passes

	public constructor(output_elm: string) {
		super();
		this.conf = <WGSL_debug_table_conf> {
			selected_pass: 0,
			pass_range: 0,
			live: false,
			dirty: false,
		};

		const scroll_elm = output_elm + "-scroll";
		const table_elm = output_elm + "-table";
		const timeline_elm = output_elm + "-timeline";
		const timelineval_elm = output_elm + "-timelineval";
		const passcount_elm = output_elm + "-passcount";
		const timelinelive_elm = output_elm + "-timelinelive";
		const passrange_elm = output_elm + "-passrange";
		const elm = <HTMLTableElement>document.getElementById(output_elm);
		if (!elm) {
			console.warn(`WGSL_debug: could not find debug output element id : '${output_elm}`);
			return;
		}

		/* inject the table object and input controls */
		elm.innerHTML = `
<div class="debug-output-controls">
	pass&nbsp;&nbsp;
	<input type="number" min="1" max="0" value="0" step="1" id="${timelineval_elm}"/> &#xb1;
	<input type="number" min="0" max="60" value="0" step="1" id="${passrange_elm}"/> /
	<span id="${passcount_elm}"></span>
	<input type="range" min="1" max="0" value="0" step="1" id="${timeline_elm}" class="debug-output-timeline"/>
	<label><input type="checkbox" checked=1 id="${timelinelive_elm}" />live</label>
</div>
<div id="${scroll_elm}" class="debug-output-table">
	<table id="${table_elm}">
	</table>
<div>
`;
		this.scroll = <HTMLTableElement>document.getElementById(scroll_elm);
		this.table = <HTMLTableElement>document.getElementById(table_elm);
		this.timeline = <HTMLInputElement>document.getElementById(timeline_elm);
		this.timelineval = <HTMLInputElement>document.getElementById(timelineval_elm);
		this.passcount = <HTMLInputElement>document.getElementById(passcount_elm);
		this.timelinelive = <HTMLInputElement>document.getElementById(timelinelive_elm);
		this.passrange = <HTMLInputElement>document.getElementById(passrange_elm);

		/* add javascript listeners */
		const table_scroll = (_: Event) => {
            //console.log("table_scroll");
			this.update();
		};
		const timeline_input = (e: Event) => {
            //console.log("timeline_input");
			this.conf.selected_pass = Number((e.target as HTMLInputElement).value);
			this.conf.live = false;
			this.update();
		};
		const timelineval_input = (e: Event) => {
            //console.log("timelineval_input");
			this.conf.selected_pass = Number((e.target as HTMLInputElement).value);
			this.conf.live = false;
			this.update();
		};
		const timelinelive_click = (e: Event) => {
            //console.log("timelinelive_click");
			this.conf.live = (e.target as HTMLInputElement).checked;
			this.update();
		};
		const passrange_input = (e: Event) => {
            //console.log("passrange_input");
			this.conf.pass_range = Number((e.target as HTMLInputElement).value);
			this.row_height = 0;
			this.debug.clear_processed();
			this.reset();
			this.update();
		};
		this.scroll.addEventListener('scroll', table_scroll);
		this.timeline.addEventListener('input', timeline_input);
		this.timelineval.addEventListener('input', timelineval_input);
		this.timelinelive.addEventListener('click', timelinelive_click);
		this.passrange.addEventListener('input', passrange_input);

		/* append CSS */
		var style = document.createElement('style');
		style.innerHTML = `
#${timelineval_elm} { width: 5em; }
#${passrange_elm} { width: 3em; }
`;
		document.head.appendChild(style);

		/* initialize view */
		this.row_height = 0; // row_height is slow to compute
		this.reset();
	}

	public reset() {
		//console.log("WGSL_debug_table reset");
		if (!this.table) {
			return;
		}

		/* reset state */
		this.col = new Array();
		this.processed = new Array();

		/* reset configuration */
		this.conf.selected_pass = 0;
		this.conf.live = true;

		/* reset table */
		this._reset_table();

		/* update controls */
		this.update();
	}

	private _reset_table() {
		this.table.innerHTML = "";
		var rowh = this.table.createTHead();
		var cellh = document.createElement("th");
		cellh.innerText = `uid`;
		rowh.appendChild(cellh);
	}

	public update() {
		if (!this.table || !this.debug) {
			return;
		}
		while (this.processed.length < this.debug.record.length) {
			this.processed.push(false);
		}
		if (window.getComputedStyle(this.table).visibility == "hidden") {
			return;
		}
		const now = Date.now();
		if (this.update_timeout
                || (this.last_update && now - this.last_update < WGSL_debug_table.MIN_UPDATE_INTERVAL)) {
			if (!this.update_timeout) {
				this.update_timeout = setTimeout(() => {
					this.update_timeout = null;
                    this.last_update = null;
					this.update();
				}, WGSL_debug_table.MIN_UPDATE_INTERVAL);
			}
			return;
		}
		this.debug.hang_detect("reset");
		//console.log(`WGSL_debug_table update ${now - this.last_update}`);
		this.last_update = now;

		const conf = this.conf;
		const debug = this.debug;
		const thead = this.table.tHead;

		/*
		 * update controls
		 */

		/* live mode needs live updating */
		if (conf.live == true) {
			conf.selected_pass = debug.pass_n;
		}

		this.timelineval.max = debug.pass_n.toString();
		this.timelineval.value = conf.selected_pass.toString();
		this.passcount.innerText = debug.pass_n.toString();
		this.timeline.max = debug.pass_n.toString();
		this.timeline.value = conf.selected_pass.toString();
		this.timelinelive.checked = conf.live;

		/*
		 * get selected pass
		 */

		const pass = debug.record[conf.selected_pass-1];
		if (!pass) {
			console.log(`table update no pass selected_pass=${conf.selected_pass} pass_n=${debug.pass_n} recordlen=${debug.record.length}`);
			return;
		}

		/*
		 * create all the necessary rows
		 */

		if (this.table.rows.length < pass.length) {
			console.log(`table update create_rows ${this.table.rows.length} to ${pass.length}`);
			if (this.table.tBodies.length == 0) {
				this.table.createTBody();
			}
			const celltext_empty = Array(1+conf.pass_range*2).fill("0").join("<br/>"); // empty string with correct height
            console.log(`table update create_rows celltext_empty=${celltext_empty}`);
			var rows = ""
			for (var n = this.table.rows.length; n < pass.length; n++) {
				rows += "<tr><th>"+n.toString()+"</th><td>"+celltext_empty+"</td></tr>\n";
			}
			this.table.tBodies[0].innerHTML += rows;
			console.log(`table update create_rows trigger`);
            this.table.rows[0].cells[1].innerHTML = celltext_empty; // trigger table cell size calculation
			console.log(`table update create_rows done`);
		}

		/*
		 * identify visible rows
		 */

		if (!this.row_height) {
			console.log("table update get first cell");
			const firstcell = this.table.rows[0].cells[1];
			/* get first cell height */
			console.log("table update get first cell style");
			const style = window.getComputedStyle(firstcell);
			console.log("table update calculate row_height");
			this.row_height = Number(style.height.replace('px',''))
				+ Number(style.paddingTop.replace('px',''))
				+ Number(style.paddingBottom.replace('px',''));
			console.log(`WGSL_debug_table setting row_height=${this.row_height}`);
		}
		//console.log("table update compute visible");
		const scrolltop = this.scroll.scrollTop;
		const table_y_visible = [ scrolltop,
		      			  scrolltop + this.scroll.clientHeight ];
		const row_visible = [ Math.floor(table_y_visible[0] / this.row_height),
				      Math.min(Math.ceil(table_y_visible[1] / this.row_height) + 1, pass.length) ];

		/*
		 * update table columns
		 */

		/* process pass */
		//console.log(`WGSL_debug_table update process_pass`);
		if (!this.processed[this.conf.selected_pass-1]) {
			pass.every((entries) => {
				if (this.debug.hang_detect("table update process_pass")) {
					return false; // break
				}
				var col_n = 0; // current column position
				/* process cells */
				entries.forEach((entry) => {
					if (entry.processed) {
						return; // continue
					}
					/* get entry value characters length */
					/* XXX this needs to be optimised: sampling ? float char len in math only ?
					 * XXX sampling: optimise by doing this not all the time, especially when we already have parsed many passes */
					var len = entry.value.toString().length + WGSL_debug_table.COL_WIDTH_ADJUST;
					if (this.conf.pass_range > 0) {
						len += 2; // we will display '*' around the current value
					}
					/* find the column where to place this entry
					 * first column with the corresponding mark will be used */
					for (var col_ins = col_n ; ; col_ins++) {
						/* mark not found, insert column at current position */
						if (col_ins == this.col.length) {
							var cellh = document.createElement("th");
							if (entry.mark != WGSL_debug.BUF_ENTRY_MARK_UNSET) {
								if (debug.marks[entry.mark]) {
									cellh.innerText = debug.marks[entry.mark];
								} else {
									cellh.innerText = entry.mark.toString();;
								}
							} else {
								cellh.innerText = "d"+col_n.toString();
							}
							thead.insertBefore(cellh, thead.children[col_n].nextSibling);
							const col: html_col_info = {
								maxlen: len,
								mark: entry.mark,
								dirty_maxlen: true,
								width: 0,
							};
							this.col.splice(col_n, 0, col); // insert
							break;
						}
						/* mark found, use this column */
						if (this.col[col_ins].mark == entry.mark) {
							col_n = col_ins;
							break;
						}
					}
					/* check if we need to update column maxlen */
					if (len > this.col[col_n].maxlen) {
						this.col[col_n].maxlen = len;
						this.col[col_n].dirty_maxlen = true;
					}
					/* move to next table column */
					col_n++;
					entry.processed = true;
				});
				return true;
			});
			this.processed[this.conf.selected_pass-1] = true;
		}

		/* update header columns width and calculate visible columns */
		//console.log(`WGSL_debug_table update header columns`);
		const table_x_visible = [ this.scroll.scrollLeft,
					  this.scroll.scrollLeft + this.scroll.clientWidth ];
		var col_offsetx = 0;
		var col_visible = [ 0, this.col.length ];
		this.col.every((col, col_n) => {
			if (this.debug.hang_detect("table update header columns", 1)) {
				return false; // break
			}
			if (col_offsetx < table_x_visible[0]) {
				col_visible[0] = col_n;
			}
			if (col.dirty_maxlen) {
				const cellh = <HTMLElement>thead.children[col_n+1];
				const s = `min-width: ${col.maxlen}ex;`;
				cellh.setAttribute("style", s);
				const style = window.getComputedStyle(cellh);
				col.width = Number(style.width.replace('px',''));
			}
			col_offsetx += col.width;
			if (col_offsetx < table_x_visible[1]) {
				col_visible[1] = col_n + 1;
			}
			return true;
		});

		/*console.log(`WGSL_debug_table row_height=${this.row_height}
table_x_visible=${table_x_visible} table_y_visible=${table_y_visible}
col_visible=${col_visible}
row_visible=${row_visible}
pass.length=${pass.length}
this.col.length=${this.col.length}`);*/

		/*
		 * update table content, only the cells that are visible
		 */

		// XXX in case of same pass, only update data that was not visible before
		// XXX eg. in case on scroll

		// XXX in case of scroll, prefetch in same direction

		for (var uid = row_visible[0]; uid < row_visible[1]; uid++) {
			if (this.debug.hang_detect("table update content")) {
				break;
			}
			const entries = pass[uid];
			const row = this.table.rows[uid];
			var col_n = 0; // current column position
			for (var entry_n = col_visible[0]; entry_n < col_visible[1]; entry_n++) {
				const entry = entries[entry_n];
				if (!entry) {
					continue;
				}
				/* find which column to use for this entry */
				while (entry.mark != this.col[col_n].mark) {
					col_n++;
					if (col_n == this.col.length) {
						/* should never happend */
						console.warn(`WGSL_debug update html table content: did not find column mark for entry at uid=${uid} entry_n=${entry_n}`);
						return;
					}
				}
				/* insert or reuse cell */
				while (!row.cells[col_n+1]) {
					row.insertCell(-1);
				}
				const cell = row.cells[col_n+1];
				/* set cell content */
				var s = "";
				if (conf.pass_range == 0) {
					s = entry.value.toString();
				} else {
					const ctx_center = Math.max(conf.pass_range, Math.min(conf.selected_pass - 1, debug.record.length - 1 - conf.pass_range));
					const ctx_first = ctx_center-conf.pass_range;
					const ctx_last = ctx_center+conf.pass_range;
					for (var ctx_n = ctx_first; ctx_n <= ctx_last; ctx_n++) {
						if (ctx_n == conf.selected_pass - 1) {
							s += "*" + entry.value + "*";
						} else {
							const ctx_pass = debug.record[ctx_n];
							s += (ctx_pass && entry_n < ctx_pass[uid].length) ? ctx_pass[uid][entry_n].value : "-";
						}
						if (ctx_n < ctx_last) {
							s += "\n";
						}
					}
				}
				cell.innerText = s;
				/* move to next table cell */
				col_n++;
			};
		};
	}

}
