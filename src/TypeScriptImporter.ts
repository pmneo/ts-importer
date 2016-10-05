import * as vscode from 'vscode';

import {ImportIndexer} from './ImportIndexer';
import { ImportIndex, Symbol, MatchMode } from './ImportIndex';
import {Importer} from './Importer';

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
    constructor( doc: vscode.TextDocument, private m: Symbol )
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

        this.detail = m.module || m.path;

        this.command = {
            title: "import",
            command: 'tsimporter.importSymbol',
            arguments: [ doc, m ]
        }
    }

}

export class TypeScriptImporter implements vscode.CompletionItemProvider, vscode.CodeActionProvider
{
    public conf<T>( property: string, defaultValue?: T ): T
    {
        return vscode.workspace.getConfiguration( 'tsimporter' ).get<T>( property, defaultValue );
    }

    public disabled: boolean = false;

    private showNotifications: boolean;

    private statusBar: vscode.StatusBarItem;

    public indexer: ImportIndexer;

    public codeCompletionIndexer: ImportIndexer;

    public importer: Importer;

    private removeFileExtensions: string[];

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

        let reindexCommand = vscode.commands.registerCommand( 'tsimporter.reindex', ( ) => {
            
            this.loadConfig();

            this.indexer.reset();
            this.indexer.attachFileWatcher();
            this.indexer.scanAll( true );
        });

        let dumpSymbolsCommand = vscode.commands.registerCommand( 'tsimporter.dumpIndex', ( ) => {
            console.log( this.indexer.index );
        });

        let importCommand = vscode.commands.registerCommand('tsimporter.importSymbol', ( document: vscode.TextDocument, symbol: Symbol ) => {
            this.importer.importSymbol( document, symbol );
        });

        this.statusBar = vscode.window.createStatusBarItem( vscode.StatusBarAlignment.Left, 1 );
        this.setStatusBar( "initializing" );
        this.statusBar.command = 'tsimporter.dumpIndex';
        this.statusBar.show();

        this.context.subscriptions.push( codeActionFixer, completionItem, codeActionFixerReact, completionItemReact, importCommand, dumpSymbolsCommand, this.statusBar );

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

        if( line && line.text.indexOf( "import" ) >= 0 && line.text.indexOf( "from" ) >= 0 )
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
            this.codeCompletionIndexer.index.resetIndex();
            this.codeCompletionIndexer.processFile( document.getText(), document.uri, false );

            var definitions: vscode.CompletionItem[] = [];

            this.indexer.index.getSymbols( "", true, MatchMode.ANY ).forEach( m => {
                
                if( this.codeCompletionIndexer.index.getSymbols( m.name, false, MatchMode.EXACT ).length == 0 )
                {
                    var ci: vscode.CompletionItem = new SymbolCompletionItem( document, m );
                    definitions.push( ci );
                }
            } );

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