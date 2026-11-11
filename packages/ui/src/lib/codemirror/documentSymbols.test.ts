import { describe, expect, test } from 'bun:test';
import { EditorState, type Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { markdown } from '@codemirror/lang-markdown';
import { csharp } from '@replit/codemirror-lang-csharp';

import {
    enclosingSymbolsAtPosition,
    extractSymbolSignatureAndDoc,
    readDocumentSymbols,
} from './documentSymbols';

const outline = (doc: string, language: Extension) => readDocumentSymbols(EditorState.create({ doc, extensions: [language] }), 5_000)
    .map(({ name, kind, line, depth }) => [name, kind, line, depth]);

describe('readDocumentSymbols', () => {
    test('lists TypeScript functions, arrow-function bindings, classes with their methods, and types', () => {
        const doc = [
            'export function foo() {}',
            'export const bar = async () => 2;',
            'const notAFunction = 3;',
            'class Baz {',
            '  method() {}',
            '  static helper = () => 1;',
            '}',
            'interface Shape { a: string }',
            'type Alias = string;',
            'enum Color { Red }',
        ].join('\n');
        expect(outline(doc, javascript({ typescript: true }))).toEqual([
            ['foo', 'function', 1, 0],
            ['bar', 'function', 2, 0],
            ['Baz', 'class', 4, 0],
            ['method', 'method', 5, 1],
            ['helper', 'method', 6, 1],
            ['Shape', 'class', 8, 0],
            ['Alias', 'type', 9, 0],
            ['Color', 'type', 10, 0],
        ]);
    });

    test('lists Python, Go and Rust declarations', () => {
        expect(outline('def foo():\n  pass\nclass Bar:\n  def m(self):\n    pass', python())).toEqual([
            ['foo', 'function', 1, 0],
            ['Bar', 'class', 3, 0],
            ['m', 'function', 4, 1],
        ]);
        expect(outline('package main\nfunc Foo() {}\nfunc (s *S) M() {}\ntype S struct {}', go())).toEqual([
            ['Foo', 'function', 2, 0],
            ['M', 'method', 3, 0],
            ['S', 'type', 4, 0],
        ]);
        expect(outline('fn foo() {}\nstruct S {}\nimpl S {\n  fn m(&self) {}\n}', rust())).toEqual([
            ['foo', 'function', 1, 0],
            ['S', 'class', 2, 0],
            ['S', 'class', 3, 0],
            ['m', 'function', 4, 1],
        ]);
    });

    test('lists C# namespaces, classes, interfaces, structs, records, enums, delegates, properties, constructors and methods', () => {
        const doc = [
            'using System;',
            'namespace Demo.Core {',
            '  public interface IUserService {',
            '    void Save(string id);',
            '  }',
            '  public record UserDto(string Name);',
            '  public struct Point { public int X; }',
            '  public enum Role { Admin, Guest }',
            '  public delegate void Notify(string msg);',
            '  public class UserService : IUserService {',
            '    public string Title { get; set; }',
            '    public UserService() {}',
            '    public void Save(string id) {',
            '      Console.WriteLine(id);',
            '    }',
            '  }',
            '}',
        ].join('\n');
        expect(outline(doc, csharp())).toEqual([
            ['Demo.Core', 'module', 2, 0],
            ['IUserService', 'class', 3, 1],
            ['Save', 'method', 4, 2],
            ['UserDto', 'class', 6, 1],
            ['Point', 'class', 7, 1],
            ['Role', 'type', 8, 1],
            ['Notify', 'type', 9, 1],
            ['UserService', 'class', 10, 1],
            ['Title', 'method', 11, 2],
            ['UserService', 'method', 12, 2],
            ['Save', 'method', 13, 2],
        ]);
    });

    test('finds enclosing symbol hierarchy and extracts JSDoc and C# XML doc comments', () => {
        const doc = [
            'namespace Demo {',
            '  /// <summary>Handles user operations.</summary>',
            '  public class UserService {',
            '    /// <summary>Saves a user record.</summary>',
            '    /// <param name="id">User identifier</param>',
            '    /// <returns>True when saved</returns>',
            '    public bool Save(string id) {',
            '      return true;',
            '    }',
            '  }',
            '}',
        ].join('\n');
        const state = EditorState.create({ doc, extensions: [csharp()] });
        const bodyPos = state.doc.line(8).from + 6;
        expect(enclosingSymbolsAtPosition(state, bodyPos, 5_000).map((s) => s.name)).toEqual([
            'Demo',
            'UserService',
            'Save',
        ]);
        const saveLine = state.doc.line(7);
        const docInfo = extractSymbolSignatureAndDoc(state, saveLine.from + 16);
        expect(docInfo.signature).toBe('public bool Save(string id)');
        expect(docInfo.documentation).toContain('Saves a user record.');
        expect(docInfo.documentation).toContain('`id`: User identifier');
        expect(docInfo.documentation).toContain('Returns: True when saved');
    });

    test('lists Markdown headings indented by level', () => {
        expect(outline('# Title\ntext\n## Part one ##\nSetext\n---', markdown())).toEqual([
            ['Title', 'heading', 1, 0],
            ['Part one', 'heading', 3, 1],
            ['Setext', 'heading', 4, 1],
        ]);
    });

    test('lists nothing for a document without a parser', () => {
        expect(readDocumentSymbols(EditorState.create({ doc: 'plain text' }))).toEqual([]);
    });
});
