// Takes an input ts file, converts types in final scope to Nim and outputs Nim file to stdout
// (c) Andi McClure 2016

import ts = require("typescript")
import util = require("util")
import fs = require("fs")
import path = require("path")
let commander = require("commander")
let error = require('commander.js-error')
let graphlib = require("graphlib")

// Get arguments

commander
	.version("0.0.1")
	.option('-o, --outfile <file>', 'Output file (omit for stdout)')
	.option('-l, --logfile <file>', 'Warnings file (omit for stderr)')
	.option('-q, --quiet', 'Suppress warnings')
	.option('--blacklist <list>', 'Comma-separated list of items to skip (see docs)')
	.option('--static-shadow', 'Block static members from being inherited by objects')
	.option('--debug-prefix <prefix>', 'Print additional info for symbols starting with...')
	.option('--debug-verbose', 'Dump entire object when printing debug information')
	.arguments("<file>")
	.parse(process.argv)
if (commander.args.length < 1)
	error("No file specified")

if (commander.args.length > 1)
	error("Too many files specified, at the moment the limit is 1")

if (commander.logfile && commander.quiet)
	error("Included both --quiet and --logfile options, which doesn't make sense")

// Get Typescript to load program

let program = ts.createProgram(commander.args, {})

let sourceFiles = program.getSourceFiles()

if (sourceFiles.length <= 1)
	error("File not found")

let typeChecker = program.getTypeChecker()

// Initialize output

let warn  : (msg: string) => void = null
let write : (msg: string) => void = null

let writeBuild = "" // Only used if commander.outfile

// Assign "write" function
if (commander.outfile) {
	// Before doing anything, make a best guess as to whether we can write the file.
	function accessSync(path: string, mode: number) { // This is silly
		try { fs.accessSync(path, mode); return true } catch (_) { return false }
	}
	let checkPath = commander.outfile
	if (!accessSync(checkPath, fs.F_OK)) // If file doesn't exist, check perms on directory
		checkPath = path.dirname(commander.outfile)
	if (!accessSync(checkPath, fs.W_OK))
		error(`Can not write output file ${commander.outfile}`)
	// TODO: Technically I guess best practice is to write to a temp file then move it in place at the end
	write = function(s: string) { writeBuild += s; writeBuild += "\n" }
} else {
	write = console.log.bind(console)
}

// Assign "warn" function
if (commander.quiet) {
	warn = function (...X) {}
} else if (commander.logfile) {
	let warnLogFile = fs.openSync(commander.logfile, "w")
	warn = function(s:string) { fs.writeSync(warnLogFile, s + "\n") }
} else {
	warn = console.warn.bind(console)
}

write("# Generated by dts2nim script")
write("# Source files:")
for (let sourceFile of sourceFiles) {
	write("#     " + sourceFile.fileName)
}

write("")
write("when not defined(js) and not defined(Nimdoc):")
write("  {.error: \"This module only works on the JavaScript platform\".}")
write("")

// Support

// Note I don't use Set/Map due to weirdness around TypeScript not expecthing them present in ES5
function emptyMap() { return Object.create(null) }
interface StringSet { [key:string] : boolean }

let blacklist : StringSet = emptyMap()
for (let key of [
	// Does not make sense outside Javascript
	"static:prototype",
	// Can't translate without namespace collision handling
	"Element.webkitRequestFullScreen", "HTMLVideoElement.webkitEnterFullscreen", "HTMLVideoElement.webkitExitFullscreen",
	"static:Event.target", "static:Performance.navigation", "static:Performance.timing",
	"MSAppAsyncOperation.ERROR", "MSWebViewAsyncOperation.ERROR",
	// Can't translate without module support
	"class:CollatorOptions", "class:CSSRule", "class:DateTimeFormatOptions", "class:NumberFormatOptions", "class:Plugin",
	].concat(commander.blacklist ? commander.blacklist.split(",") : []))
		blacklist[key] = true

function blacklisted(nspace:string, name1:string, name2:string = null) : boolean {
	if (name2) {
		let combined = name1 + "." + name2
		return blacklist[name2] || blacklist[nspace + ":" + name2]
			|| blacklist[combined] || blacklist[nspace + ":" + combined]
	} else {
		return blacklist[name1] || blacklist[nspace + ":" + name1]
	}
}

// Assume enum is a bitfield, print all relevant bits.
// If "tight", assume enum values are exact values, not masks.
function enumBitstring(Enum, value:number, tight = false) : string {
	let result = ""
	for (let key in Enum) {
		let bit = Enum[key]
		if (typeof bit != "number" || !bit) continue
		let masked = value&bit
		if (tight ? (masked==bit) : masked) {
			if (result) result += "+"
			result += key
		}
	}
	return result
}

// Are all bits in b set in a?
function hasBit(a:number, b:number) { return (a&b)==b }

function capitalizeFirstLetter(str:string) : string {
	return str.charAt(0).toUpperCase() + str.slice(1)
}

let reserved : StringSet = emptyMap()
for (let name of ["addr", "and", "as", "asm", "atomic", "bind", "block", "break", "case", "cast",
	"concept", "const", "continue", "converter", "defer", "discard", "distinct", "div", "do",
	"elif", "else", "end", "enum", "except", "export", "finally", "for", "from", "func", "generic",
	"if", "import", "in", "include", "interface", "is", "isnot", "iterator", "let", "macro",
	"method", "mixin", "mod", "nil", "not", "notin", "object", "of", "or", "out", "proc", "ptr",
	"raise", "ref", "return", "shl", "shr", "static", "template", "try", "tuple", "type", "using",
	"var", "when", "while", "with", "without", "xor", "yield"])
	reserved[name] = true

// Convert TypeScript identifier to legal Nim identifier
// FIXME: Leaves open possibility of collisions
function identifierScrub(id:string, nameSpace:string = null) : string {
	if (nameSpace)
		id = nameSpace + capitalizeFirstLetter(id)
	id = id
		.replace(/_{2,}/, "_")
		.replace(/\$/, "zz")
	if (id[0] == '_')
		id = "z" + capitalizeFirstLetter(id.slice(1))
	if (reserved[id])
		id = "x" + capitalizeFirstLetter(id)
	return id
}

function needIdentifierScrub(id:string, nameSpace:string = null) : boolean {
	return id != identifierScrub(id)
}

// Print the symbol that goes inside the quotes for an importc or importcpp
function importIdentifier(id:string, nameSpace:string = null) : string {
	if (nameSpace)
		id = nameSpace + "." + id
	return id
		.replace(/\$/, "$$$$")
}

// Print {.importc.} with possible symbol correction
function importDirective(id:string, cpp:boolean = false, nameSpace:string = null) : string {
	return "importc" + (cpp?"pp":"") +
		(nameSpace || id != identifierScrub(id) ? ":\"" + importIdentifier(id, nameSpace) + "\"" : "")
}

function arrayFilter<T>(x: T) : T[] {
	return x != null ? [x] : []
}

function concatAll<T>(x:T[][]) : T[] {
	return [].concat.apply([], x)
}

function joinPrefixed(a: string[], prefix: string) {
	return a.map(g => prefix + g).join("")
}

function tarjanResults(graph) {
	return graphlib.alg.tarjan(graph)
		.map( scc => scc.map( id => graph.node(id) ) )
}

// Exceptions

// This is needed to work around an issue in Typescript's ES5 generator
class CustomError extends Error {
	constructor(message:string) {
		super()
		this.message = message
	}
}

class GenConstructFail extends CustomError {	
}

// Raised on Typescript type the converter script doesn't know how to convert
class UnusableType extends GenConstructFail {
	constructor(public type: ts.Type) {
		super("Cannot represent type: " + typeChecker.typeToString(type))
	}
}

// Generator classes

// There is a series of Gen types which represent type items and know how to convert them to strings.
// There is also a vendor (a factory) which knows how to create the Gen types given TypeScript objects.
// The Gen constructors should take "pre-digested" data and do very little. Error checking should be
// done in the vendor, not in the Gen.
// If output types other than Nim are at some point supported, the gens will need to be subclassed,
// and the vendor may or may not need to be significantly subclassed.

interface GenVendor {
	typeGen(tsType: ts.Type)
}

interface Gen {
	suppress?: boolean  // Can and maybe has been instantiated, but shouldn't be output to file

	declString(nameSpace?:string) : string

	depends() : string[] // TODO: Return a Gen[]
	dependKey(): string  // Return the key you are described by in a dependency graph, or null
}

function allDepends(gens: Gen[]) : string[] {
	return concatAll( gens.map( x => x.depends() ) )
}

function genJoin(a:Gen[], joiner:string) {
	return a.map(g => g.declString()).join(joiner)
}

function declsFor(a: Gen[])  { return genJoin(a, "\n\n") }

// FIXME: So the way unions are handled right now is a little weird. paramsGen returns an array of arrays, where each
// sub-array corresponds to all possible types that could appear at that position. That array of arrays is then passed
// in here, which generates an array of strings, corresponding to all possible type signatures that could be generated
// from treating the input as a list of sets.
//
// A better way to do ALL of this would for TypeGens to have a flag saying "are you compound?". Consumers of TypeGens
// that can't handle compoundness could throw when the flag is set, and SignatureTypeGens with compound components
// could themselves be compound.
function paramsFor(a: Gen[][]) {
	let results: string[] = ['']
	for (let paramList of a) {
		let newResults = []
		for (let param of paramList) {
			let paramString = param.declString()
			for (let existing of results) {
				let newResult = existing
				if (newResult)
					newResult += ", "
				newResult += paramString
				newResults.push(newResult)
			}
		}
		results = newResults
	}
	return results
}

// KLUDGE: genJoinPrefixed gets a nameSpace form and genJoin doesn't
function genJoinPrefixed(a:Gen[], prefix:string, nameSpace: string = null) {
	return a.map(g => prefix + g.declString(nameSpace)).join("")
}

interface TypeGen extends Gen {
	typeString() : string
}

class IdentifierGen implements Gen {
	constructor(public name:string, public type: TypeGen) {}

	declString() : string { throw new Error("Tried to print declaration for abstract identifier base class") }

	depends()   { return arrayFilter(this.type.dependKey()) }
	dependKey() { return this.name } // FIXME: Could variables live without these?
}

class VariableGen extends IdentifierGen implements Gen {
	declString(nameSpace: string = null) : string {
		return `var ${identifierScrub(this.name, nameSpace)}* {.${importDirective(this.name, false, nameSpace)}, nodecl.}: `
		     + this.type.typeString()
	}
}

class ParameterGen extends IdentifierGen implements Gen {
	declString() : string {
		return `${identifierScrub(this.name)}: ${this.type.typeString()}`
	}
}

class FieldGen extends IdentifierGen implements Gen {
	declString() : string {
		return `${identifierScrub(this.name)}* {.${importDirective(this.name)}.}`
		     + `: ${this.type.typeString()}`
	}	
}

class SignatureBase {
	constructor(public params:ParameterGen[][], public returnType: TypeGen) {}

	depends() {
		return concatAll( this.params.map(allDepends) )
			   		.concat( arrayFilter(this.returnType.dependKey()) )
	}
}

class SignatureGen extends SignatureBase implements Gen { // Function signature
	owner: ClassGen
	constructor(public name: string, params:ParameterGen[][], returnType: TypeGen) {
		super(params, returnType)
	}

	declString(nameSpace: string = null) : string {
		let fullParams = (this.owner ? [[new ParameterGen("self", this.owner)]] : [])
		               .concat( this.params )
		return paramsFor(fullParams).map(paramString =>
		     `proc ${identifierScrub(this.name, nameSpace)}*(${paramString}) : `
		     + this.returnType.typeString()
			 + ` {.${importDirective(this.name, !!this.owner, nameSpace)}.}`
		).join("\n")
	}
	dependKey() { return this.name }
}

class SignatureTypeGen extends SignatureBase implements TypeGen {
	declString() : string { throw new CustomError("Tried to emit a declaration for a procedure type") }
	typeString() : string {
		let paramStrings = paramsFor(this.params)

		if (paramStrings.length != 1)
			throw new CustomError("Union-type arguments in a place this is not allowed")

		return `proc (${paramStrings[0]}) : ${this.returnType.typeString()}`
	}

	dependKey() { return null }
}

class ConstructorGen implements Gen {
	owner: ClassGen // Set by ClassGen.init
	constructor(public params:ParameterGen[][]) {}
	declString() : string {
		let scrubbed = identifierScrub(this.owner.name)
		let name = "new" + capitalizeFirstLetter(scrubbed)
		// Note: params.length check is to work around a bug which is fixed in newest Nim beta
		return paramsFor(this.params).map(paramString =>
		     `proc ${name}*(${paramString}) : ${scrubbed}`
			 + ` {.importcpp:"new ${importIdentifier(this.owner.name)}${this.params.length?"(@)":""}".}`
		).join("")
	}

	depends() {
		return concatAll( this.params.map(allDepends) )
	}
	dependKey() { return null } // Constructors dont stand alone
}

class ConstructorSpec {
	constructors: ConstructorGen[]
	foundConstructors: number // Includes constructors that could not be converted to gens
	constructor() {
		this.constructors = []
		this.foundConstructors = 0
	}
}

class LiteralTypeGen implements TypeGen {
	constructor(public literal: string) {}

	declString() : string { throw new CustomError("Tried to emit a declaration for a core type") }
	typeString() { return this.literal }

	depends() { return [] }
	dependKey() { return null }
}

class MemberSpec {
	constructor(public fields: IdentifierGen[], public methods: SignatureGen[]) {}
}

enum ClassInitPhase {
	Zero,
	InheritanceInProgress,
	Inheritance,
	FullInProgress,
	Full,
	Invalid
}

class ClassGen implements TypeGen { // TODO: Make name optional?
	// Inherit may be null. "abstract" refers to a class that can be inherited from but not instantiated.
	inherit: ClassGen
	constructors: ConstructorGen[]
	members: MemberSpec
	statics: MemberSpec

	initPhase: ClassInitPhase
	tempSymbol: ts.Symbol
	tempExtraSource: () => ClassExtraSpec
	suppress: boolean  // Can and maybe has been instantiated, but shouldn't be output to file
	constructor(public name: string, public abstract: boolean) {
		this.initPhase = ClassInitPhase.Zero
	}
	init(constructors: ConstructorGen[], fields: IdentifierGen[], methods: SignatureGen[], staticFields: IdentifierGen[], staticMethods: SignatureGen[]) {
		this.constructors = constructors
		this.members = new MemberSpec(fields, methods)
		this.statics = new MemberSpec(staticFields, staticMethods)
		for (let constructor of constructors)
			constructor.owner = this
		for (let method of methods)
			method.owner = this
		this.initPhase = ClassInitPhase.Full
	}

	declString() : string {
		return "type " + this.declStringInternal() + this.declStringExternal()
	}

	// The part of the declaration inside and outside the type is split out here for the benefit of CollectionGen
	declStringInternal() : string {
		return `${identifierScrub(this.name)}* {.${importDirective(this.name)}.} = ref object of `
		     + (this.inherit ? identifierScrub(this.inherit.name) : "RootObj")
			 + genJoinPrefixed(this.members.fields, "\n    ") // Four spaces
	}
	declStringExternal() : string {
		let fullMethods: Gen[] = this.members.methods
		if (!this.abstract)
			fullMethods = (this.constructors as Gen[]).concat( fullMethods )
		return genJoinPrefixed(fullMethods, "\n")
			 + genJoinPrefixed(this.statics.fields, "\n", this.name)
		     + genJoinPrefixed(this.statics.methods, "\n", this.name)
	}

	typeString() {
		return this.name
	}

	depends() {
		return concatAll(
			[this.members.fields, this.constructors, this.members.methods, this.statics.fields, this.statics.methods]
				.map( x => allDepends(x) )
		).concat( this.inherit ? [this.inherit.dependKey()] : [] )
	}
	dependKey() { return this.name }
}

// A group of mutually recursive types
class CollectionGen implements Gen {
	constructor(public gens: Gen[]) {}

	declString() : string {
		let inheritance = new graphlib.Graph()
		let gens: Gen[] = []
		for (let gen of this.gens) {
			if (gen instanceof ClassGen) {
				let key = gen.dependKey()
				inheritance.setNode(key, gen)
				if (gen.inherit)
					inheritance.setEdge(key, gen.inherit.dependKey())
			}
			else {
				gens.push(gen) // This ought to be empty
			}
		}

		// Need to do a quick graph sort to make sure types are printed after their parents
		let groupedClassGens : ClassGen[][] = tarjanResults(inheritance)
		let classGens: ClassGen[] = []
		for (let group of groupedClassGens) {
			if (group.length > 1) // This should be impossible, given filtering which has occurred already?
				warn("The following types were ignored because they appear to have an inheritance cycle:"
                  + (group.map(x => x.dependKey())).join(", ")) // This is a misuse of dependKey
			else if (group[0]) // if !group[0] then a class inherits from something outside the collection
				classGens.push(group[0])
		}

		return "type"
			 + joinPrefixed(classGens.map(gen => gen.declStringInternal()), "\n  ") // Two spaces
			 + classGens.map(gen => gen.declStringExternal()).join("")
			 + genJoinPrefixed(gens, "\n")
	}

	// In theory these will not be used
	depends() { return allDepends(this.gens) }
	dependKey() { return this.gens.map(x => x.dependKey).join("-") }
}

class ClassExtraSpec {
	constructor(public constructors: ConstructorSpec, public statics: MemberSpec, public banFields: StringSet) {}
}

function chainHasField(gen:ClassGen, name:string) : boolean {
	if (!gen)
		return false
	for(let field of gen.members.fields)
		if (field.name == name)
			return true
	return chainHasField(gen.inherit, name)
}

class GenVendor {
	classes: {[name:string] : ClassGen}
	constructor() {
		this.classes = emptyMap()
	}

	variableGen(sym: ts.Symbol, tsType: ts.Type) : VariableGen {
		try {
			if (blacklisted("variable", sym.name))
				throw new GenConstructFail(`Refusing to translate blacklisted variable ${sym.name}`)

			return new VariableGen(sym.name, vendor.typeGen(tsType))
			
		} catch (_e) {
			let e:{} = _e
			if (e instanceof UnusableType)
				throw new GenConstructFail(`Could not translate variable ${sym.name} because couldn't translate type ${typeChecker.typeToString(e.type)}`)
			else
				throw e
		}
	}

	paramsGen(syms: ts.Symbol[]) : ParameterGen[][] {
		return syms.map(sym => {
			let tsType = typeChecker.getTypeOfSymbolAtLocation(sym, sourceFile.endOfFileToken)
			// Unions are not supported by dts2nim overall, but they are supported in the special case of params
			let subTypes = tsType.flags & ts.TypeFlags.Union ?
				(tsType as any).types : // CHEAT: Types field on unions is not exposed
				[tsType]

			// FIXME: This throws UnusableType but in the case of a union we could just skip unusable types
			return subTypes.map(subType => new ParameterGen(sym.name, this.typeGen(subType)))
		})
	}

	signatureGen(sym: ts.Symbol, callSignature: ts.Signature) : SignatureGen {
		return new SignatureGen(sym.name, this.paramsGen(callSignature.getParameters()), this.typeGen(callSignature.getReturnType()))
	}

	functionGen(sym: ts.Symbol, tsType: ts.Type) : SignatureGen[] {
		if (blacklisted("variable", sym.name))
			throw new GenConstructFail(`Refusing to translate blacklisted function ${sym.name}`)

		let result: SignatureGen[] = []
		let counter = 0
		for (let callSignature of tsType.getCallSignatures()) {
			try {
				counter++
				result.push( this.signatureGen(sym, callSignature) )
			} catch (e) {
				if (e instanceof UnusableType)
					warn(`Could not translate function ${sym.name}`
						+ (counter > 0 ? `, call signature #${counter}` : "")
						+ ` because tried to translate ${typeChecker.typeToString(tsType)}`
						+ ` but couldn't translate type ${typeChecker.typeToString(e.type)}`
					)
				else
					throw e
			}
		}
		return result
	}

	signatureTypeGen(tsType: ts.Type, callSignature: ts.Signature) : SignatureTypeGen {
		let params = this.paramsGen(callSignature.getParameters())

		// FIXME: At the moment unions aren't supported here.
		for (let param of params)
			if (param.length > 1)
				throw new UnusableType(tsType)

		return new SignatureTypeGen(params, this.typeGen(callSignature.getReturnType()))
	}

	constructorSpec(declarations: ts.Declaration[], ownerName: string = "(unknown)") : ConstructorSpec {
		let spec = new ConstructorSpec()
		for (let declaration of declarations) {
			spec.foundConstructors++
			try {
				spec.constructors.push( new ConstructorGen(
					// Parameters exist on Declaration but are not publicly exposed. CHEAT:
					this.paramsGen( (declaration as any).parameters.map(node => node.symbol) )
				) )
			} catch (_e) {
				let e:{} = _e
				if (e instanceof UnusableType)
					warn(`Could not translate constructor #${spec.foundConstructors} on class ${ownerName}`
					   + ` because couldn't translate type ${typeChecker.typeToString(e.type)}`
					)
				else
					throw _e
			}
		}

		return spec
	}

	field(member: ts.Symbol, memberType: ts.Type, ownerName: string, inherit: ClassGen, isStatic = false) : IdentifierGen[] {
		let fields : IdentifierGen[] = []
		let staticTag = isStatic ? "static " : ""
		try {
			if (blacklisted(isStatic ? "static" : "field", ownerName, member.name))
				warn(`Refusing to translate blacklisted ${staticTag}field ${member.name} of class ${ownerName}`)
			else if (!(inherit && chainHasField(inherit, member.name)))
				fields.push(new (isStatic ? VariableGen : FieldGen)(member.name, this.typeGen(memberType)))
		} catch (_e) {
			let e:{} = _e
			if (e instanceof UnusableType)
				warn(`Could not translate ${staticTag}field ${member.name} on class ${ownerName}`
				  +  ` because couldn't translate type ${typeChecker.typeToString(e.type)}`
				)
			else
				throw _e
		}
		return fields
	}

	methods(member: ts.Symbol, memberType: ts.Type, ownerName: string, isStatic = false) : SignatureGen[] {
		let methods : SignatureGen[] = []
		let staticTag = isStatic ? "static " : ""
		if (blacklisted(isStatic ? "static" : "field", ownerName, member.name)) {
			warn(`Refusing to translate blacklisted ${staticTag}method ${member.name} of class ${ownerName}`)
		} else {
			let counter = 0
			for (let callSignature of memberType.getCallSignatures()) {
				try {
					counter++
					methods.push( this.signatureGen(member, callSignature) )
				} catch (_e) {
					let e:{} = _e
					if (e instanceof UnusableType)
						warn(`Could not translate ${staticTag}method ${member.name} on class ${ownerName}`
							+ (counter > 0 ? `, call signature #${counter}` : "")
							+ ` because tried to translate ${typeChecker.typeToString(memberType)}`
							+ ` but couldn't translate type ${typeChecker.typeToString(e.type)}`
							)
					else
						throw _e
				}
			}
		}

		return methods
	}

	collectionGen(gens : Gen[]) {
		return new CollectionGen(gens)
	}

	// Some notes on ClassGen init phases: Initialization happens in two phases.
	// Inheritance load: The class object is created. The inherit field is filled out. (This phase can fail.)
	// Full load: All fields are filled out, all member fields, methods, constructors etc are known. (This phase can't fail.)
	// When the symbol list is being iterated, each class is given a full load as it is reached.
	// If a field is full loaded, all its ancestors get full loads first (so constructors and fields can be compared)
	// If a class references another class in a field/method/etc, that class and all its ancestors get inheritance loads (so it is known if they failed).
	classGen(sym: ts.Symbol, tsType: ts.Type, fullLoad = false, abstract = false, classExtraSource: () => ClassExtraSpec = null) : ClassGen {
		function classType() {
			if (!tsType)
				tsType = typeChecker.getTypeOfSymbolAtLocation(sym, sourceFile.endOfFileToken)
			return tsType
		}
		function classUnusableType() { return new UnusableType(classType()) }
		function classKind() { return abstract ? "interface" : "class" }

		let name = sym.name
		let result = this.classes[name]
		if (result) {
			if (result.initPhase == ClassInitPhase.Invalid)
				throw classUnusableType()
			if (result.initPhase == ClassInitPhase.Full
					|| (!fullLoad && result.initPhase >= ClassInitPhase.InheritanceInProgress))
				return result
			if (result.initPhase == ClassInitPhase.FullInProgress)
				throw new CustomError("Class ${name} somehow attempted to do a full init while a full init is already in progress. This should be impossible.")
		}

		if (!result) {
			result = new ClassGen(name, abstract)
			this.classes[name] = result
		}

		try {
			if (result.initPhase < ClassInitPhase.Inheritance) {
				result.initPhase = ClassInitPhase.InheritanceInProgress

				if (blacklisted("class", name)) {
					warn("Refusing to translate blacklisted ${classKind()} " + name)
					throw classUnusableType()
				}

				// Get superclass
				// Neither "heritageClauses" nor "types" are exposed. CHEAT:
				let heritageClauses = (sym.declarations[0] as any).heritageClauses
				
				if (heritageClauses) {
					let inheritSymbol = typeChecker.getSymbolAtLocation(heritageClauses[0].types[0].expression)

					let inheritName = inheritSymbol.name

					let inherit = vendor.classGen(inheritSymbol, null)

					if (inherit.initPhase < ClassInitPhase.Inheritance) { // Don't check for invalid, classGen will throw if needed
						warn(`${classKind()} ${name} has an inheritance loop with its ancestor ${inheritName}`)
						throw classUnusableType()
					}

					result.inherit = inherit
				}
				result.tempSymbol = sym
				result.tempExtraSource = classExtraSource
				result.initPhase = ClassInitPhase.Inheritance
			}

			if (fullLoad)
				this.classInit(result)

			return result
		} catch (_e) {
			let e:{} = _e
			result.initPhase = ClassInitPhase.Invalid
			if (e instanceof UnusableType && e.type !== classType()) { // TODO: This would be unnecessary with try-catches above.
				warn(`Could not translate ${classKind()} ${name} because could not translate type `
					+ typeChecker.typeToString(e.type))
				throw classUnusableType()
			}
			throw(e)
		}
	}

	classInit(result: ClassGen) {
		try {			
			let name = result.name

			if (result.initPhase == ClassInitPhase.Full)
				return
			else if (result.initPhase != ClassInitPhase.Inheritance)
				throw new CustomError(`Attempted to perform full init on class ${name} while it is in a seemingly impossible state (${result.initPhase}, expected ${ClassInitPhase.Inheritance}).`)

			result.initPhase = ClassInitPhase.FullInProgress

			if (result.inherit)
				this.classInit(result.inherit)

			let sym = result.tempSymbol
			let classExtra = result.tempExtraSource ? result.tempExtraSource() : null
			let fields : IdentifierGen[] = []
			let methods: SignatureGen[] = []
			let staticFields : IdentifierGen [] = classExtra ? classExtra.statics.fields.slice() : []
			let staticMethods : SignatureGen [] = classExtra ? classExtra.statics.methods.slice() : []
			let constructors: ConstructorGen[]  = classExtra ? classExtra.constructors.constructors.slice() : []
			let foundConstructors               = classExtra ? classExtra.constructors.foundConstructors : 0
			let extraBanFields : StringSet      = classExtra ? classExtra.banFields : emptyMap()

			// Iterate over class members
			// Public interface for SymbolTable lets you look up keys but not iterate them. CHEAT:
			for (let key in sym.members as any) {
				let member = sym.members[key]
				let memberType = typeChecker.getTypeOfSymbolAtLocation(member, sourceFile.endOfFileToken)
				
				// Member is a constructor
				if (hasBit(member.flags, ts.SymbolFlags.Constructor)) {
					let spec = this.constructorSpec(member.declarations, name)
					constructors = constructors.concat( spec.constructors )
					foundConstructors += spec.foundConstructors

				// Member is a field
				} else if (hasBit(member.flags, ts.SymbolFlags.Property)) {
					if (extraBanFields[member.name])
						continue

					fields = fields.concat( this.field(member, memberType, name, result.inherit) )

				// Member is a method
				} else if (hasBit(member.flags, ts.SymbolFlags.Method)) {
					if (extraBanFields[member.name])
						continue

					methods = methods.concat( this.methods(member, memberType, name) )

				// Member is unsupported
				} else {
					warn(`Could not figure out how to translate member ${member.name} of class ${name}`)
				}
			}

			// CHEAT: Same cheat as members, see above
			for (let key in sym.exports as any) {
				let member = sym.exports[key]
				let memberType = typeChecker.getTypeOfSymbolAtLocation(member, sourceFile.endOfFileToken)

				// Static member is a field
				if (hasBit(member.flags, ts.SymbolFlags.Property)) {
					staticFields = staticFields.concat( this.field(member, memberType, name, result.inherit, true) )

				// Static member is a method
				} else if (hasBit(member.flags, ts.SymbolFlags.Method)) {
					staticMethods = staticMethods.concat( this.methods(member, memberType, name, true) )

				// Static member is unsupported
				} else {
					warn(`Could not figure out how to translate static member ${member.name} of class ${name}`)
				}
			}

			// Get constructor
			if (!foundConstructors) {
				if (result.inherit && result.inherit.constructors) {
					for (let constructor of result.inherit.constructors) {
						constructors.push(new ConstructorGen( constructor.params ))
					}
				} else {
					constructors.push(new ConstructorGen([]))
				}
			}

			result.init(constructors, fields, methods, staticFields, staticMethods) // Will set init phase full
		} catch (e) {
			result.initPhase = ClassInitPhase.Invalid
			throw e
		} finally {
			result.tempSymbol = null
			result.tempExtraSource = null
		}
	}

	// A standard pattern in d.ts files is to mimic a class by means of a interface+variable combo
	// paired with a separate interface describing the class's constructor. The d.ts authors do
	// this instead of just declaring a class in order to get slightly different scope rules.
	// This script does not care about scope rules and can safely just collapse into a class.
	pseudoClassGen(sym: ts.Symbol, tsType: ts.Type, fullLoad = false) {
		let typeMembers = tsType.symbol.members
		let constructor = typeMembers['__new']

		// This is done in a thunk so that classGen can decide when or if to execute it
		let classExtraSource = () => {
			let name = sym.name
			let typeIsSelf = tsType.symbol === sym

			if (!typeIsSelf) {
				let constructorClass = this.classGen(tsType.symbol, null)
				constructorClass.suppress = true
			}

			let constructorSpec = constructor ? this.constructorSpec(constructor.declarations, name) : new ConstructorSpec()

			let fields: IdentifierGen[] = []
			let methods: SignatureGen[] = []
			let extraBanFields : StringSet = emptyMap()

			// CHEAT: The members cheat again, see classGen
			for (let key in typeMembers as any) {
				let member = typeMembers[key]
				let memberType = typeChecker.getTypeOfSymbolAtLocation(member, sourceFile.endOfFileToken)
				
				// Member is a field
				if (hasBit(member.flags, ts.SymbolFlags.Property)) {
					fields = fields.concat( this.field(member, memberType, name, null, true) ) // True because these are statics

				// Member is a method
				} else if (hasBit(member.flags, ts.SymbolFlags.Method)) {
					methods = methods.concat( this.methods(member, memberType, name, true) )

				// Member is unsupported
				} else {
					warn(`Could not figure out how to translate member ${member.name} of class ${name}`)
				}
			}

			// This is an attempt to prevent static fields inherited via prototype from unhelpfully appearing in object instances.
			if (commander.staticShadow) {
				for (let field of fields)
					extraBanFields[field.name] = true
				if (typeIsSelf) // Only shadow methods for enum-type/module-type pseudoclasses. // FIXME: Does this actually make sense?
					for (let method of methods)
						extraBanFields[method.name] = true
			}

			return new ClassExtraSpec(constructorSpec, new MemberSpec(fields, methods), extraBanFields)
		}

		// Abstract if no constructor was found
		return this.classGen(sym, tsType, fullLoad, !constructor, classExtraSource)
	}

	typeGen(tsType: ts.Type) : TypeGen {
		if (tsType.flags & ts.TypeFlags.Number) // FIXME: Numberlike?
			return new LiteralTypeGen("float")
		if (tsType.flags & ts.TypeFlags.String) // FIXME: Stringlike?
			return new LiteralTypeGen("cstring")
		if (tsType.flags & ts.TypeFlags.Void)
			return new LiteralTypeGen("void")
		if (tsType.flags & ts.TypeFlags.Boolean)
			return new LiteralTypeGen("bool")
		if ((tsType.flags & (ts.TypeFlags.Class | ts.TypeFlags.Interface)) && tsType.symbol) {
			if (tsType.symbol.flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.FunctionScopedVariable))
				return this.pseudoClassGen(tsType.symbol, tsType)

			return this.classGen(tsType.symbol, tsType)
		}

		if (tsType.flags & ts.TypeFlags.Anonymous) {
			let callSignatures = tsType.getCallSignatures()
			if (callSignatures.length == 1)
				return this.signatureTypeGen(tsType, callSignatures[0])
		}
		
		throw new UnusableType(tsType)
	}
}

// Process input

let vendor = new GenVendor()

// Prefix `prefix` to every line of `string`, starting at line `startAtLine`
function linePrefix(str:string, prefix:string, startAtLine = 0) : string {
	let ary = str.split("\n")
	for (let idx in ary) {
		if (+idx >= startAtLine)
			ary[idx] = prefix + ary[idx]
	}
	return ary.join("\n")
}

// Return a string containing a commented-out string representation of an object,
// for tacking onto the end of an existing comment line
function debugVerboseEpilogue(obj:any) : string {
	if (!commander.debugVerbose)
		return ""
	return ", " + linePrefix(util.inspect(obj), "#         ", 1)
}

// Emit symbols

let sourceFile = sourceFiles[sourceFiles.length-1]
let generators : Gen[] = []

for (let sym of typeChecker.getSymbolsInScope(sourceFile.endOfFileToken, 0xFFFFFFFF)) {
	let tsType = typeChecker.getTypeOfSymbolAtLocation(sym, sourceFile.endOfFileToken)
	
	// Handle --debugPrefix command
	if (commander.debugPrefix && sym.name.substr(0, commander.debugPrefix.length) == commander.debugPrefix)
		write("\n# " + sym.name + ": " + typeChecker.typeToString(tsType) +
			"\n#     Node:" + enumBitstring(ts.SymbolFlags, sym.flags, true) +
			debugVerboseEpilogue(sym) +
			"\n#     Type:" + enumBitstring(ts.TypeFlags, tsType.flags, true) +
			debugVerboseEpilogue(tsType)
		)

	// Variable
	try {
		// Class
		if (hasBit(sym.flags, ts.SymbolFlags.Class)) {
			generators.push( vendor.classGen(sym, tsType, true) )

		} else if (sym.flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.FunctionScopedVariable)) {
			if (hasBit(sym.flags, ts.SymbolFlags.Interface))
				generators.push( vendor.pseudoClassGen(sym, tsType, true) )
			else
				generators.push( vendor.variableGen(sym, tsType) )

		// Interface
		} else if (hasBit(sym.flags, ts.SymbolFlags.Interface)) {
			generators.push( vendor.classGen(sym, tsType, true, true) )

		// Function
		} else if (hasBit(sym.flags, ts.SymbolFlags.Function)) {
			generators = generators.concat( vendor.functionGen(sym, tsType) )

		// Unsupported
		} else {
			warn(`Could not figure out how to translate symbol ${sym.name}:`
				+ typeChecker.typeToString(tsType))
		}
	} catch (_e) {
		let e:{} = _e
		if (e instanceof GenConstructFail)
			warn(e.message)
		else
			throw e
	}
}

// We now have a list of all symbols in alphabetical order. We need to sort them in order of
// relative dependency, and if any of the symbols are mutually recursive types we need to know that
// too. The tarjan algorithm (strongly connected components, reverse topological sort) does both
let dependencies = new graphlib.Graph()
for (let gen of generators) {
	let key = gen.dependKey()
	dependencies.setNode(key, gen)
	for (let dep of gen.depends())
		dependencies.setEdge(key, dep)
}

let groupedGenerators : Gen[][] = tarjanResults(dependencies)

let sortedGenerators : Gen[] = []
for (let group of groupedGenerators) {
	if (group.length > 1) {
		sortedGenerators.push( vendor.collectionGen(group.filter(gen => !gen.suppress)) )
	} else if (group[0]) { // TODO: Delete nodes that depend on nonexistent things
		if (!group[0].suppress)
			sortedGenerators.push(group[0])
	}
}

write( declsFor(sortedGenerators) )

// We successfully reached the end, so if we have a file to write we can do that now
if (commander.outfile)
	fs.writeFileSync(commander.outfile, writeBuild)