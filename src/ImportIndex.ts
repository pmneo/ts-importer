import * as path from 'path';
import * as vscode from 'vscode';

import * as fs from 'fs';

export interface Symbol {
    name: string,
    module: string,
    path: string,
    type: string,
    isDefault: boolean, 
    asDefinition: string
}

export enum MatchMode
{
    EXACT, START, END, ANY
}

function matches( value: string, test: string, ignoreCase: boolean, mode: MatchMode ): boolean
{
    value = value || '';
    test = test || '';
    
    if( ignoreCase )
    {
        value = value.toLocaleLowerCase();
        test = test.toLocaleLowerCase();
    }

    var valid: boolean = false;

    valid = valid || ( mode == MatchMode.EXACT && value == test );
    valid = valid || ( mode == MatchMode.START && value.startsWith( test ) );
    valid = valid || ( mode == MatchMode.ANY && value.indexOf( test ) >= 0 );
    valid = valid || ( mode == MatchMode.END && value.endsWith( test ) );

    return valid;
}

function exists( path: string ): boolean
{
    try
    {
        return !!fs.statSync( path );
    }
    catch( e )
    {
        return false;
    }
}

export class ImportIndex {

    private knownSymbols: { [name: string] : Symbol[] };
    
    public constructor() {
        this.resetIndex();
    }

    public resetIndex(): void {
        this.knownSymbols = {};
    }

    public get symbolCount() 
    {
        var c = 0;
        
        for( var k in this.knownSymbols )
            c += this.knownSymbols[k].length;

        return c;
    }

    public getSymbols(name: string, ignoreCase: boolean = false, mode: MatchMode = MatchMode.EXACT ): Symbol[] 
    {
        if( mode == MatchMode.EXACT && !ignoreCase )
        {
            return this.knownSymbols[ name ] || [];
        }

        var result: Symbol[] = [];

        for( var k in this.knownSymbols )
        {
            if( matches( k, name, ignoreCase, mode ) )
                result.push.apply( result, this.knownSymbols[k] );
        }

        return result;
    }

    public getModules( name: string, ignoreCase: boolean = false, mode: MatchMode = MatchMode.EXACT ): string[] 
    {
        var modules: string[] = [];

        for( var k in this.knownSymbols )
        {
            var imports = this.knownSymbols[ k ];

            for( var i = 0; i<imports.length; i++ )
            {
                var imp = imports[i];

                if( matches( imp.module, name, ignoreCase, mode ) && modules.indexOf( imp.module ) < 0 )
                    modules.push( imp.module );
            }
            
        }

        modules.sort();

        return modules;
    }

    public deleteByPath( fsPath: string ): void
    {
        var toDelete: Symbol[] = [];

        for( var name in this.knownSymbols )
        {
            let symbols = this.knownSymbols[name];
            
            for( let i=0; i<symbols.length; i++ )
                if( symbols[i].path == fsPath )
                    toDelete.push( symbols[i] );
        }

        for( let i=0; i<toDelete.length; i++ )
            this.delete( toDelete[i] );
    } 

    public delete( obj: Symbol ): void 
    {
        var current = this.getSymbols( obj.name, false, MatchMode.EXACT );

        var updated = [ ];

        for( var i = 0; i < current.length; i++ )
        {
            var c = current[i];

            if( obj.module == c.module )
                continue;

            if( !c.path || exists( c.path ) )
                updated.push( c );
        }

        if( updated.length )
            this.knownSymbols[ obj.name ] = updated;
        else
            delete this.knownSymbols[ obj.name ];
    }

    public addSymbol( name: string, module: string, path: string, type: string, isDefault: boolean, asDefinition: string ): Symbol 
    {
        name = name.trim();

        if (name.length == 0 )
            return null; 
        
        let obj: Symbol = {
            name,
            module,
            path,
            type,
            isDefault,
            asDefinition
        }

        var updated = [ obj ];

        var current = this.getSymbols( obj.name, false, MatchMode.EXACT );

        var updated = [ obj ];

        for( var i = 0; i < current.length; i++ )
        {
            var c = current[i];

            if( obj.module == c.module )
            {
                obj.path = obj.path || c.path;
                obj.type = obj.type || c.type;
                obj.isDefault = obj.isDefault || c.isDefault;
                obj.asDefinition = obj.asDefinition || c.asDefinition;
                continue;
            }

            if( !c.path || exists( c.path ) )
                updated.push( c );
        }

        this.knownSymbols[ obj.name ] = updated;
    }
}