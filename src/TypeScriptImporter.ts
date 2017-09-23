import * as vscode from 'vscode';

import {ImportIndexer} from './ImportIndexer';
import { ImportIndex, Symbol, MatchMode } from './ImportIndex';
import {Importer} from './Importer';
import * as path from 'path';

export function activate( context: vscode.ExtensionContext ): void 
{
    let importer = new TypeScriptImporter(context);

    if( importer.disabled )
        return;

    importer.start();
}

export function deactivate() {

}

class SymbolCompletionItem extends vscode.CompletionItem
{
    constructor( doc: vscode.TextDocument, public m: Symbol, lowImportance: boolean )
    {
        super( m.name );

        if( !m.type )
            this.kind = vscode.CompletionItemKind.File;
        else if( m.type.indexOf( "class" ) >= 0 ) 
            this.kind = vscode.CompletionItemKind.Class;
        else if( m.type.indexOf( "interface" ) >= 0 )
            this.kind = vscode.CompletionItemKind.Interface;
        else if( m.type.indexOf( "function" ) >= 0 )
            this.kind = vscode.CompletionItemKind.Function;
        else
            this.kind = vscode.CompletionItemKind.Variable; 

        this.description = this.documentation = m.module || m.path;

        if( lowImportance )
        {
            this.sortText = "zzzzzzzzzz" + m.name;
            this.label = m.name;
            this.insertText = m.name;
        }

        if( doc )
            this.command = {
                title: "import",
                command: 'tsimporter.importSymbol',
                arguments: [ doc, m ]
            }
    }

    public description: string;
}

function getSelectedWord(): string {
    if( !vscode.window.activeTextEditor )
        return "";

    let document = vscode.window.activeTextEditor.document;

    if( !document )
        return "";

    let word = "";

    let selection = vscode.window.activeTextEditor.selection;

    if( selection ) {
        let w: vscode.Range = selection;
        
        if( selection.isEmpty )
            w = document.getWordRangeAtPosition( selection.active );

        if( w && w.isSingleLine ) {
            word = document.getText( w );
        }
    }

    return word;
}

export class TypeScriptImporter implements vscode.CompletionItemProvider, vscode.CodeActionProvider
{
    public conf<T>( property: string, defaultValue?: T ): T
    {
        return vscode.workspace.getConfiguration( 'tsimporter' ).get<T>( property, defaultValue );
    }

    public disabled: boolean = false;
    public noStatusBar: boolean = false;

    private showNotifications: boolean;

    private statusBar: vscode.StatusBarItem;

    public indexer: ImportIndexer;

    public codeCompletionIndexer: ImportIndexer;

    public importer: Importer;

    private removeFileExtensions: string[];

    public lowImportance: boolean = false;
    public emitSemicolon: boolean = true;

    constructor( private context: vscode.ExtensionContext )
    {
        if( vscode.workspace.rootPath === undefined )
            this.disabled = true;
        else 
            this.disabled = this.conf<boolean>( "disabled" );

        this.loadConfig();
    }

    protected loadConfig(): void {
        this.showNotifications = this.conf<boolean>('showNotifications');
        this.removeFileExtensions = this.conf<string>('removeFileExtensions', '.d.ts,.ts,.tsx').trim().split(/\s*,\s*/);
        this.lowImportance = this.conf<boolean>('lowImportance', false);
        this.emitSemicolon = this.conf<boolean>('emitSemicolon', true);
        this.noStatusBar = this.conf<boolean>('noStatusBar', false);
    }

    public start(): void
    {
        this.indexer = new ImportIndexer( this );
        this.indexer.attachFileWatcher();
        
        this.codeCompletionIndexer = new ImportIndexer( this );
        this.importer = new Importer( this );


        let codeActionFixer = vscode.languages.registerCodeActionsProvider('typescript', this)
        let completionItem = vscode.languages.registerCompletionItemProvider('typescript', this)

        let codeActionFixerReact = vscode.languages.registerCodeActionsProvider('typescriptreact', this)
        let completionItemReact = vscode.languages.registerCompletionItemProvider('typescriptreact', this)

        let codeActionFixerVue = vscode.languages.registerCodeActionsProvider('vue', this)
        let completionItemVue = vscode.languages.registerCompletionItemProvider('vue', this)

        let reindexCommand = vscode.commands.registerCommand( 'tsimporter.reindex', ( ) => {
            
            this.loadConfig();

            this.indexer.reset();
            this.indexer.attachFileWatcher();
            this.indexer.scanAll( true );
        });

        let addImport = vscode.commands.registerCommand( 'tsimporter.addImport', ( ) => {
            
            if( !vscode.window.activeTextEditor )
                return;

            let document = vscode.window.activeTextEditor.document;

            let word = getSelectedWord();

            this.codeCompletionIndexer.index.resetIndex();
            this.codeCompletionIndexer.processFile( document.getText(), document.uri, false );

            var definitions: SymbolCompletionItem[] = [];
            this.indexer.index.getSymbols( word, true, MatchMode.ANY ).forEach( m => {
                
                if( this.codeCompletionIndexer.index.getSymbols( m.name, false, MatchMode.EXACT ).length == 0 )
                {
                    var ci = new SymbolCompletionItem( document, m, this.lowImportance );
                    definitions.push( ci );
                }
            } );

            let importItem = item => {
                if( item )
                    vscode.commands.executeCommand( item.command.command, item.command.arguments[0], item.command.arguments[1] );
            };

            if( definitions.length == 0 ) {
                vscode.window.showInformationMessage( "no importable symbols found!" )
            }
            else if( definitions.length == 1 ) {
                importItem( definitions[0] );
            }
            else {
                vscode.window.showQuickPick<SymbolCompletionItem>( definitions ).then( importItem );
            }
        });

        let openSymbol = vscode.commands.registerCommand( 'tsimporter.openSymbol', ( ) => {
            
            let word = getSelectedWord();

            var definitions: SymbolCompletionItem[] = [];
            this.indexer.index.getSymbols( word, true, MatchMode.ANY ).forEach( m => {
                if( m.path ) {
                    var ci = new SymbolCompletionItem( null, m, this.lowImportance );
                    definitions.push( ci );
                }
            } );

            let openItem = item => {
                if( item ) {
                    let uri = vscode.Uri.file( item.m.path );
                    console.log( uri );
                    vscode.workspace.openTextDocument( uri ).then( 
                        r => {
                            vscode.window.showTextDocument( r );
                        }, 
                        f => { 
                            console.error( "fault", f ) 
                        }
                    );
                }
            };

            if( definitions.length == 0 ) {
                vscode.window.showInformationMessage( "no importable symbols found!" )
            }
            else if( definitions.length == 1 ) {
                openItem( definitions[0] );
            }
            else {
                vscode.window.showQuickPick<SymbolCompletionItem>( definitions ).then( openItem );
            }
        });

        let dumpSymbolsCommand = vscode.commands.registerCommand( 'tsimporter.dumpIndex', ( ) => {
            let change = vscode.window.onDidChangeActiveTextEditor( e => {
                change.dispose();

                let edit = new vscode.WorkspaceEdit();
                edit.insert( 
                    e.document.uri, 
                    new vscode.Position( 0, 0 ), 
                    JSON.stringify( this.indexer.index, null, "\t" ) 
                );
                vscode.workspace.applyEdit( edit );
            } );
            vscode.commands.executeCommand( "workbench.action.files.newUntitledFile" );
        });

        let importCommand = vscode.commands.registerCommand('tsimporter.importSymbol', ( document: vscode.TextDocument, symbol: Symbol ) => {
            this.importer.importSymbol( document, symbol );
        });

        this.statusBar = vscode.window.createStatusBarItem( vscode.StatusBarAlignment.Left, 1 );
        this.setStatusBar( "initializing" );
        this.statusBar.command = 'tsimporter.dumpIndex';

        if( this.noStatusBar )
            this.statusBar.hide();
        else
            this.statusBar.show();

        this.context.subscriptions.push( codeActionFixer, completionItem, codeActionFixerReact, completionItemReact, codeActionFixerVue, completionItemVue, importCommand, dumpSymbolsCommand, this.statusBar );

        vscode.commands.executeCommand('tsimporter.reindex', { showOutput: true });
    }

    public removeFileExtension( fileName: string ): string
    {
        for( var i = 0; i<this.removeFileExtensions.length; i++ )
        {
            var e = this.removeFileExtensions[i];

            if( fileName.endsWith( e ) )
                return fileName.substring( 0, fileName.length - e.length );
        }

        return fileName;
    }

    public showNotificationMessage( message: string ): void {
        if( this.showNotifications )
            vscode.window.showInformationMessage('[TypeScript Importer] ' + message );
    }

    private status: string = "Initializing";

    public setStatusBar( status: string ) {
        this.status = status;

        if( this.statusBar )
            this.statusBar.text = "[TypeScript Importer]: " + this.status;
    }



    /**
     * Provide completion items for the given position and document.
     *
     * @param document The document in which the command was invoked.
     * @param position The position at which the command was invoked.
     * @param token A cancellation token.
     * @return An array of completions, a [completion list](#CompletionList), or a thenable that resolves to either.
     * The lack of a result can be signaled by returning `undefined`, `null`, or an empty array.
     */
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] | Thenable<vscode.CompletionItem[]> | vscode.CompletionList | Thenable<vscode.CompletionList> {

        var line = document.lineAt( position.line );
        var lineText = line.text;

        if( lineText ) {

            var docText = document.getText();
            var len = document.offsetAt( position );
            let idx = 0;

            enum MODE {
                Code,
                MultiLineComment,
                LineComment,
                SingleQuoteString,
                DoubleQuoteString,
                MultiLineString
            }

            let mode = MODE.Code;

            while( idx < len ) {
                let next = docText.substr( idx, 1 );
                let next2 = docText.substr( idx, 2 );

                switch( mode ) {
                    case MODE.Code: {
                        if( next2 == "/*" ) {
                            mode = MODE.MultiLineComment;
                            idx++;
                        }
                        else if( next2 == "//" ) {
                            mode = MODE.LineComment;
                            idx++;
                        }
                        else if( next == "'" )
                            mode = MODE.SingleQuoteString;
                        else if( next == '"' )
                            mode = MODE.DoubleQuoteString;
                        else if( next == '`' )
                            mode = MODE.MultiLineString;
                    } break;
                    case MODE.MultiLineComment: {
                        if( next2 == "*/" ) {
                            mode = MODE.Code;
                            idx++;
                        }
                    }break;
                    case MODE.LineComment: {
                        if( next == "\n" ) {
                            mode = MODE.Code;
                        }
                    }break;
                    case MODE.SingleQuoteString: {
                        if( next == "'" || next == "\n" )
                            mode = MODE.Code;
                    }break;
                    case MODE.DoubleQuoteString: {
                        if( next == '"' || next == "\n" )
                            mode = MODE.Code;
                    }break;
                    case MODE.MultiLineString: {
                        if( next == '`' )
                            mode = MODE.Code;
                    }break;
                }

                idx++;
            }

            //console.log( "parsed mode is", mode );

            if( mode != MODE.Code )
                return;
        }

        if( lineText && lineText.indexOf( "import" ) >= 0 && lineText.indexOf( "from" ) >= 0 )
        {
            var delims = ["'", '"'];

            var end = position.character;
            var start = end - 1;
            
            while( delims.indexOf( lineText.charAt( start ) ) < 0 && start > 0 )
                start --;

            if( start > 0 )
            {
                var moduleText = lineText.substring( start + 1, end );
                return this.provideModuleCompletionItems( moduleText, new vscode.Range( new vscode.Position( position.line, start + 1 ), new vscode.Position( position.line, position.character ) ) );
            }
            else
            {
                return [];
            }
        }
        else// if( range )
        {
            let s = new Date().getTime();

            let range: vscode.Range = null;//document.getWordRangeAtPosition( position );

            let word = "";
            if( range && range.isSingleLine && !range.isEmpty )
                word = document.getText( range ).trim();

            this.codeCompletionIndexer.index.resetIndex();
            this.codeCompletionIndexer.processFile( document.getText(), document.uri, false );

            var definitions: vscode.CompletionItem[] = [];
            this.indexer.index.getSymbols( word, true, MatchMode.ANY ).forEach( m => {
                
                if( this.codeCompletionIndexer.index.getSymbols( m.name, false, MatchMode.EXACT ).length == 0 )
                {
                    var ci: vscode.CompletionItem = new SymbolCompletionItem( document, m, this.lowImportance );
                    definitions.push( ci );
                }
            } );

            //console.log( "provided", definitions.length, "within", (new Date().getTime() - s), "ms" );

            return definitions;
        }
    }

    provideModuleCompletionItems( searchText: string, replaceRange: vscode.Range ): vscode.CompletionItem[]
    {
        var modules: vscode.CompletionItem[] = [];

        this.indexer.index.getModules( searchText, true, MatchMode.ANY ).forEach( m => {
            var ci: vscode.CompletionItem = new vscode.CompletionItem( m );
            
            ci.kind = vscode.CompletionItemKind.File;
            ci.textEdit = new vscode.TextEdit( replaceRange, m ); 

            modules.push( ci );
        } );

        return modules;
    }

    /**
     * Given a completion item fill in more data, like [doc-comment](#CompletionItem.documentation)
     * or [details](#CompletionItem.detail).
     *
     * The editor will only resolve a completion item once.
     *
     * @param item A completion item currently active in the UI.
     * @param token A cancellation token.
     * @return The resolved completion item or a thenable that resolves to of such. It is OK to return the given
     * `item`. When no result is returned, the given `item` will be used.
     */
    resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.CompletionItem | Thenable<vscode.CompletionItem> {
        return item;
    }


    /**
     * Provide commands for the given document and range.
     *
     * @param document The document in which the command was invoked.
     * @param range The range for which the command was invoked.
     * @param context Context carrying additional information.
     * @param token A cancellation token.
     * @return An array of commands or a thenable of such. The lack of a result can be
     * signaled by returning `undefined`, `null`, or an empty array.
     */
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.Command[] | Thenable<vscode.Command[]> {
        
        if( context && context.diagnostics )
        {
            for( var i=0; i<context.diagnostics.length; i++ )
            {
                var symbols = this.getSymbolsForDiagnostic( context.diagnostics[i].message );

                if( symbols.length )
                {
                    let handlers = [];

                    for( var s=0; s<symbols.length; s++ )
                    {
                        var symbol = symbols[s];

                        handlers.push( {
                            title: this.importer.createImportStatement( this.importer.createImportDefinition( symbol.name ), this.importer.resolveModule( document, symbol ) ),
                            command: 'tsimporter.importSymbol',
                            arguments: [ document, symbol ]
                        } );
                    };

                    return handlers;
                }
            }
        }
        
        return [];
    }

    private getSymbolsForDiagnostic( message: string ): Symbol[]
    {
        var test = /Cannot find name ['"](.*?)['"]\./;
        var match: string[];

        if ( message && ( match = test.exec( message ) ) ) 
        {
            let missing = match[1];
            return this.indexer.index.getSymbols( missing, false, MatchMode.EXACT );
        }
        else
            return [];
    }

}
