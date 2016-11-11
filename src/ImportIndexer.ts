import { TypeScriptImporter } from './TypeScriptImporter';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { ImportIndex } from './ImportIndex';

const BATCH_SIZE = 50;

function toGlob( p: string[] ): string
{
    return p.length == 1 ? p[0] : ( "{"+p.join(",")+"}");
}

function toSA( value: any ): string[]
{
    if( value === void 0 )
        return [];
    else if( typeof value === 'string' )
        return [ value ];
    else
        return value;
}

export class ImportIndexer
{
    private scanStarted: Date;
    private scanEnded: Date;
    private paths: string[];
    private filesToScan: string[];
    private filesToExclude: string[];
    private fileWatcher: vscode.FileSystemWatcher;

    public index: ImportIndex;


    constructor( protected importer: TypeScriptImporter )
    {
        this.reset();
    }

    public reset(): void 
    {
        this.index = new ImportIndex();
        this.filesToScan = toSA( this.importer.conf<string[]>('filesToScan') );
        this.filesToExclude = toSA( this.importer.conf<string[]>('filesToExclude') );

        var tsconfig: any;

        try
        {
            tsconfig = JSON.parse( fs.readFileSync( vscode.workspace.rootPath + "/" + this.importer.conf( 'tsconfigName', 'tsconfig.json' ) ).toString() )
        }
        catch( e )
        {
            tsconfig = undefined;
        }

        if( tsconfig && tsconfig.compilerOptions )
        {
            this.paths = tsconfig.compilerOptions.paths ? tsconfig.compilerOptions.paths["*"] : undefined;

            if( this.paths )
            {
                for( let i=0; i<this.paths.length; i++ )
                {
                    let p: string[] = path.resolve( vscode.workspace.rootPath, this.paths[i] ).split( /[\/\\]/ );
                    p[ p.length - 1 ] = "";

                    this.paths[i] = p.join( "/" );
                }
            }
            else
                this.paths = [];
        }
        else
            this.paths = [];
    }

    public attachFileWatcher(): void
    {
        if( this.fileWatcher )
        {
            this.fileWatcher.dispose();
            this.fileWatcher = undefined;
        }

        let watcher = this.fileWatcher = vscode.workspace.createFileSystemWatcher( toGlob( this.filesToScan ) );

        var batch: string[] = [];
        var batchTimeout: any = undefined;

        var batchHandler = () => {
            batchTimeout = undefined;
            //this.processWorkspaceFiles( batch.splice( 0, batch.length ), false, true );
            
            vscode.workspace
                .findFiles( toGlob( this.filesToScan ), toGlob( [ '**/node_modules/**' ].concat( this.filesToExclude ) ), 99999)
                .then((files) => {
                    var b = batch.splice( 0, batch.length );

                    if( b.length )
                        this.processWorkspaceFiles( files.filter( f => b.indexOf( f.fsPath ) >= 0 ), false, true );
            } );
        }

        var addBatch = ( file: vscode.Uri ) => {
            batch.push( file.fsPath );

            if( batchTimeout )
            {
                clearTimeout( batchTimeout );
                batchTimeout = undefined;
            }

            batchTimeout = setTimeout( batchHandler, 250 );
        }

        watcher.onDidChange((file: vscode.Uri) => {
            addBatch( file );
        });

        watcher.onDidCreate((file: vscode.Uri) => {
            addBatch( file );
        });

        watcher.onDidDelete((file: vscode.Uri) => {
            this.fileDeleted( file );
        });
    }

    public scanAll( showNotifications: boolean ): void 
    {
        this.scanStarted = new Date();
        vscode.workspace
            .findFiles( toGlob( this.filesToScan ), toGlob( [ '**/node_modules/**' ].concat( this.filesToExclude ) ), 99999)
            .then((files) => this.processWorkspaceFiles( files, showNotifications, false ) );
    }

    private fileDeleted( file: vscode.Uri ): void
    {
        this.index.deleteByPath( file.fsPath );
        this.printSummary();
    }

    private printSummary(): void
    {
        this.importer.setStatusBar( "Symbols: " + this.index.symbolCount );
    }

    private processWorkspaceFiles( files: vscode.Uri[], showNotifications: boolean, deleteByFile: boolean ): void 
    {
        files = files.filter((f) => {
            return f.fsPath.indexOf('typings') === -1 &&
                f.fsPath.indexOf('node_modules') === -1 &&
                f.fsPath.indexOf('jspm_packages') === -1;
        });

        console.log( "processWorkspaceFiles", files, showNotifications, deleteByFile );

        var fi = 0; 

        var next = () => {
            for( var x = 0; x < BATCH_SIZE && fi < files.length; x++)
            {
                this.importer.setStatusBar( "processing " + fi + "/" + files.length  );

                var file = files[fi++];

                try
                {
                    var data = fs.readFileSync( file.fsPath, 'utf8' );
                    this.processFile(data, file, deleteByFile);
                }
                catch( err )
                {
                    console.log( "Failed to loadFile", err );
                }
            }
            
            if( fi == files.length )
            {
                this.scanEnded = new Date();

                this.printSummary();

                if ( showNotifications ) 
                    this.importer.showNotificationMessage( `cache creation complete - (${Math.abs(<any>this.scanStarted - <any>this.scanEnded)}ms)` );

                return;
            }

            //loop async
            setTimeout( next, 0 );
        };

        next();
    }


    public processFile( data: string, file: vscode.Uri, deleteByFile: boolean ): void 
    {
        if( deleteByFile )
            this.index.deleteByPath( file.fsPath );

        var fsPath = file.fsPath.replace( /[\/\\]/g, "/" );

        fsPath = this.importer.removeFileExtension( fsPath );

        var path = file.fsPath;
        var module = undefined;

        for( var i=0; i<this.paths.length; i++ )
        {
            var p = this.paths[i]
            if( fsPath.substr( 0, p.length ) == p )
            {
                module = fsPath.substr( p.length );
                break;
            }
        }

        var typesRegEx = /(export\s+?(default\s+?)?(?:((?:(?:abstract\s+)?class)|(?:type)|(?:interface)|(?:function(?:\s*\*)?)|(?:let)|(?:var)|(?:const)|(?:enum))\s+)?)([a-zA-z]\w*)/g;
        var typeMatches: string[];
        while ( ( typeMatches = typesRegEx.exec( data ) ) ) 
        {   
            let isDefault: string = typeMatches[2];
            let symbolType: string = typeMatches[3];
            let symbolName: string = typeMatches[4];

            this.index.addSymbol( symbolName, module, path, symbolType, !!isDefault, undefined );
        }

        var importRegEx = /\bimport\s+(?:({?)\s*(.+?)\s*}?\s+from\s+)?[\'"]([^"\']+)["\']/g;
        var imports: string[];
        while( imports = importRegEx.exec( data ) ) 
        {
            if( !imports[2] )
                continue;

            let importModule = imports[3];

            if( importModule.indexOf( './' ) < 0 && importModule.indexOf( '!' ) < 0)
            {
                let symbols = imports[2].split( /\s*,\s*/g );

                for( var s = 0; s < symbols.length; s++ )
                {
                    let symbolName: string = symbols[s];

                    let asStmtMatch = /\*\s+as\s+(.*)/.exec( symbolName );
                    let asStmt: string = undefined;
                    
                    if( asStmtMatch )
                    {
                        asStmt = symbolName;
                        symbolName = asStmtMatch[1];
                    }

                    this.index.addSymbol( symbolName, importModule, undefined, undefined, imports[1] != "{", asStmt );
                }
            }
        }
    }
}