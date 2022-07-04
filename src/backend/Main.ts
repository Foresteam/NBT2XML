import path from 'path';
import chokidar from 'chokidar';
import fs from 'fs';
import Reader from './Reader';
import Writer from './Writer';
import tmp from 'tmp-promise';
import fsp from 'fs/promises';
import { Config } from './Common';
import os from 'os';
import glob from 'glob';
import { spawn } from 'child_process';
import Options from '@/shared/Options';
import { ErrorCode } from '@/shared/ErrorCodes';

export const FindTopFolderName = (p: string): string => {
	let parts = p.split(path.sep);
	let i = 0;
	for (; i < parts.length; i++)
		if (parts[i].indexOf('*') >= 0 || parts[i].indexOf('?') >= 0) {
			break;
		}
	return path.resolve(parts.splice(0, i).join(path.sep));
}
export const SubtractBeginning = (path: string, top: string) => {
	path = path.substring(top.length);
	if (path.startsWith('/'))
		path = path.substring(1);
	return path;
}

export interface OpenFileArgs {
	/** Input file */
	input: string;

	/** Out directory */
	dir?: string;

	/** The part with future "project directory" */
	inputMeaningful?: string;

	/** Out name, "single convert mode" */
	outName?: string;

	edit?: boolean;
	gzip?: boolean;
	bulk?: boolean;
	xmlinput?: boolean;
	snbt?: boolean;
}
export interface OpenFileResult {
	filename?: string;
	watcher?: chokidar.FSWatcher;
	convertPromise?: Promise<void>;
}
const OpenFile = async ({ input, inputMeaningful, dir, outName, xmlinput, gzip, edit, snbt, bulk }: OpenFileArgs): Promise<OpenFileResult> => {
	// out=false means we should create temp file. Else we only create the missing path component
	// now we have to check outName too...
	let out = '';
	let xmlsuf = !xmlinput ? '.xml' : '';
	if (dir !== undefined)
		out = path.join(dir, inputMeaningful + xmlsuf);
	else if (outName)
		out = outName;

	if (out)
		try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { }

	const XML2NBT = async (input: string, out: string) => {
		if (!out)
			throw ErrorCode.XML_NO_OUT;
		console.log(`Writing to ${out}`);
		await Writer.X2NPipe(input, out, { gzip });
	}
	if (xmlinput || !bulk && input.endsWith('.xml')) {
		if (gzip == undefined)
			throw ErrorCode.XML_COMPRESSION_UNDEFINED;
		return { convertPromise: XML2NBT(input, out) };
	}
	else {
		if (gzip == undefined) {
			let istream = fs.createReadStream(input, { mode: 1 });
			let header: Buffer = await new Promise(resolve => istream.on('readable', () => resolve(istream.read(3))));
			gzip = header.compare(new Uint8Array([0x1f, 0x8b, 0x08])) == 0;
			istream.close();
		}
		if (!out)
			out = tmp.fileSync({ 'name': path.basename(input) + '.xml' });
		let convertPromise = fsp.writeFile(input + '.backup', fs.readFileSync(input, 'binary'), 'binary').then(() => {
			console.log(`Backup written (${input}.backup)`);
			return Reader.N2XPipe(input, out, { gzip, parseSNBT: snbt }).then(() =>
				console.log(`Conversion done (${out})`)
			);
		});
		if (!edit)
			return { convertPromise };
		await convertPromise;
		let watcher = chokidar.watch(out, { awaitWriteFinish: true });
		watcher.on('change', () => XML2NBT(out, input));
		return { filename: out, watcher };
	}
}

const APPDATA = os.platform() == 'linux' ? os.homedir() + '/.config/XNBTEdit/' : '';
const CONFIG = APPDATA + 'config.json';
try { APPDATA && fs.mkdirSync(APPDATA); } catch { }

export const config = new Config(CONFIG, {});

export const Configure = (prop: string, value: any) => {
	config.set(prop, value);
	console.log(`Wrote configuration to "${CONFIG}".`);
}
export const CheckOpenGUI = ({ edit, out, input}: Options) => !edit && out == undefined && !input;

export const Perform = async ({ bulk, input: _input, edit, out: _out, overwrite, xmlinput, compression: gzip, snbt }: Options) => {
	if (!_input)
		throw ErrorCode.NO_INPUT;
	if (!edit && !_out)
		throw ErrorCode.NO_OUT_NO_EDIT;
	
	const inputs: string[] = [];
	if (bulk) {
		try {
			if (fs.statSync(_input).isFile())
				throw 0;
		}
		catch (e) {
			if (e == 0)
				throw ErrorCode.BULK_INPUT_FILE;
		}

		try {
			if (!fs.statSync(_input).isFile())
				await new Promise<void>(resolve => glob(path.join(_input, '**', '*'), (err, files) => {
					if (err)
						throw ErrorCode.IDK;
					for (let filename of files)
						if (fs.statSync(filename).isFile())
							inputs.push(path.resolve(filename))
					resolve();
				}));
		}
		catch {
			let fns = (await new Promise(resolve => glob(_input, (err, files) => {
				if (err)
					throw ErrorCode.IDK;
				resolve(files);
			}))) as string[];
			for (let filename of fns)
				inputs.push(path.resolve(filename));
		}
	}
	else
		inputs.push(path.resolve(_input));

	const top = FindTopFolderName(_input);
	let dir = '';
	if (bulk) {
		if (edit)
			dir = tmp.dirSync();
		else if (_out !== undefined) {
			dir = _out;
			try {
				if (fs.readdirSync(dir).length > 0)
					if (overwrite)
						console.log('Output directory already exists and is not empty. Overwriting...'.bold);
					else
						throw 0;
			} catch (e) {
				if (e == 0)
					throw ErrorCode.ASK_OVERWRITE;
			}
		}
		else
			throw ErrorCode.NO_OUT_NO_EDIT;
	}
	
	const opened: OpenFileResult[] = [];
	for (let fn of inputs)
		opened.push(await OpenFile({
			input: fn,
			inputMeaningful: SubtractBeginning(fn, top),
			dir: dir,
			outName: !bulk ? _out : undefined,
			snbt, bulk, xmlinput, gzip: gzip as boolean | undefined, edit
		}));

	process.on('exit', () => opened.forEach(rs => {
		if (!rs.watcher || rs.filename == undefined)
			return;
		rs.watcher.close();
		fs.rmSync(rs.filename);
	}));

	if (edit)
		await spawn(config.get().config_editor as string, [dir !== undefined ? dir : opened[0].filename as string]);
	
	return opened;
}