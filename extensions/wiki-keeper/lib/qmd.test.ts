import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isQmdStatusTextEmpty, parseExistingCollectionFromAddOutput } from "./qmd.ts";

describe("qmd — isQmdStatusTextEmpty", () => {
	it("matches '0 documents'", () => {
		assert.equal(isQmdStatusTextEmpty("Collection: foo\n0 documents"), true);
	});

	it("matches '0 document' (singular)", () => {
		assert.equal(isQmdStatusTextEmpty("0 document indexed"), true);
	});

	it("matches 'documents: 0'", () => {
		assert.equal(isQmdStatusTextEmpty("status\ndocuments: 0\nready"), true);
	});

	it("matches 'document = 0'", () => {
		assert.equal(isQmdStatusTextEmpty("document = 0"), true);
	});

	it("matches 'no documents'", () => {
		assert.equal(isQmdStatusTextEmpty("collection has no documents"), true);
	});

	it("matches 'no document' (singular)", () => {
		assert.equal(isQmdStatusTextEmpty("no document found"), true);
	});

	it("matches 'collection empty'", () => {
		assert.equal(isQmdStatusTextEmpty("Status: collection empty"), true);
	});

	it("is case-insensitive", () => {
		assert.equal(isQmdStatusTextEmpty("0 DOCUMENTS"), true);
		assert.equal(isQmdStatusTextEmpty("NO DOCUMENTS"), true);
	});

	it("returns false for non-empty collection text", () => {
		assert.equal(isQmdStatusTextEmpty("42 documents indexed"), false);
		assert.equal(isQmdStatusTextEmpty("collection foo: 1 document, ready"), false);
	});

	it("returns false for unrelated stderr text", () => {
		assert.equal(isQmdStatusTextEmpty("", "warning: something"), false);
	});

	it("returns false for empty input", () => {
		assert.equal(isQmdStatusTextEmpty(""), false);
		assert.equal(isQmdStatusTextEmpty("", ""), false);
	});

	it("checks both stdout and stderr", () => {
		assert.equal(isQmdStatusTextEmpty("", "0 documents"), true);
	});

	it("does not false-positive on '10 documents' or similar", () => {
		assert.equal(isQmdStatusTextEmpty("10 documents"), false, "should not match because regex uses \\b0\\b");
		assert.equal(isQmdStatusTextEmpty("100 documents"), false);
	});
});

describe("qmd — parseExistingCollectionFromAddOutput", () => {
	it("extracts the existing collection name from a path-conflict message", () => {
		const stderr = `A collection already exists for this path and pattern:\n  Name: project-wiki (qmd://project-wiki/)\n  Pattern: **/*.md\n\nUse 'qmd update' to re-index it, or remove it first with 'qmd collection remove project-wiki'`;
		assert.equal(parseExistingCollectionFromAddOutput("", stderr), "project-wiki");
	});

	it("handles hashed/dashed collection names", () => {
		const stderr = `A collection already exists for this path and pattern:\n  Name: jaybelo-253d3a2d-wiki (qmd://jaybelo-253d3a2d-wiki/)`;
		assert.equal(parseExistingCollectionFromAddOutput("", stderr), "jaybelo-253d3a2d-wiki");
	});

	it("returns undefined when output is unrelated", () => {
		assert.equal(parseExistingCollectionFromAddOutput("Added collection foo"), undefined);
		assert.equal(parseExistingCollectionFromAddOutput("", "some other error"), undefined);
	});

	it("returns undefined for same-name-exists (no path-conflict marker)", () => {
		assert.equal(parseExistingCollectionFromAddOutput("", "Collection already exists with name foo"), undefined);
	});
});
