import { useEffect, useRef, useState } from 'react';
import { Folder, ChevronRight, FileText, LocateFixed, Search } from 'lucide-react';
import { type Project, type FileItem, type Change } from '../../shared/types';
import { readableError } from '../lib/format';
import { IconButton } from './IconButton';
const api = window.desktop;

interface FileTreeProps {
  project: Project;
  onSelect: (name: string) => void;
  selectedFile?: string;
  changes?: Change[];
  revision?: number;
}

function ChangeMarker({ change }: { change?: Change }) {
  return change ? (
    <span className={'tree-change ' + (change.status === '删除' ? 'deleted' : '')} title={change.status}>
      {change.status === '新增' ? '+' : change.status === '删除' ? '−' : 'M'}
    </span>
  ) : null;
}

function Directory({
  project,
  onSelect,
  selectedFile,
  changes,
  revision,
  directory = '',
  depth = 0,
  locate,
}: FileTreeProps & { directory?: string; depth?: number; locate: number }) {
  const [items, setItems] = useState<FileItem[]>([]),
    [open, setOpen] = useState<string[]>([]),
    [error, setError] = useState('');
  const selected = useRef<HTMLButtonElement>(null);
  const located = useRef(0);
  useEffect(() => {
    let alive = true;
    api
      .invoke('files', project.id, directory)
      .then((value) => {
        if (alive) {
          setItems(value);
          setError('');
        }
      })
      .catch((error) => {
        if (alive) setError(readableError(error));
      });
    return () => {
      alive = false;
    };
  }, [project.id, directory, revision]);
  useEffect(() => {
    if (!locate || !selectedFile || !items.length || located.current === locate) return;
    located.current = locate;
    setOpen((old) => [
      ...new Set([
        ...old,
        ...items
          .filter((item) => item.directory && selectedFile.startsWith(item.path + '/'))
          .map((item) => item.path),
      ]),
    ]);
    selected.current?.scrollIntoView({ block: 'nearest' });
  }, [locate, items, selectedFile]);
  return (
    <div className="file-tree">
      {error && <p className="inline-error">{error}</p>}
      {!items.length && !error && <p className="empty-small">{depth ? '空文件夹' : '没有可显示的文件'}</p>}
      {items.map((item) => (
        <div key={item.path}>
          <button
            ref={item.path === selectedFile ? selected : undefined}
            className={'file-row ' + (item.path === selectedFile ? 'active' : '')}
            style={{ paddingLeft: 12 + depth * 14 }}
            title={item.path}
            onClick={() =>
              item.directory
                ? setOpen((old) =>
                    old.includes(item.path) ? old.filter((name) => name !== item.path) : [...old, item.path],
                  )
                : onSelect(item.path)
            }
          >
            {item.directory ? (
              <>
                <ChevronRight size={12} className={open.includes(item.path) ? 'rotated' : ''} />
                <Folder size={14} />
              </>
            ) : (
              <>
                <span className="tree-indent" />
                <FileText size={14} />
              </>
            )}
            <span className="tree-name">{item.name}</span>
            {!item.directory && (
              <ChangeMarker change={changes?.find((change) => change.path === item.path)} />
            )}
          </button>
          {item.directory && open.includes(item.path) && (
            <Directory
              project={project}
              directory={item.path}
              depth={depth + 1}
              onSelect={onSelect}
              selectedFile={selectedFile}
              changes={changes}
              revision={revision}
              locate={locate}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function FileTree(props: FileTreeProps) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<string[]>([]),
    [error, setError] = useState(''),
    [locate, setLocate] = useState(0);
  useEffect(() => {
    setQuery('');
    setResults([]);
    setError('');
    setLocate(0);
  }, [props.project.id]);
  useEffect(() => {
    if (!query.trim()) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        api
          .invoke('searchFiles', props.project.id, query)
          .then((files) => {
            if (alive) {
              setResults(files);
              setError('');
            }
          })
          .catch((error) => {
            if (alive) setError(readableError(error));
          }),
      50,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, props.project.id, props.revision]);
  return (
    <div className="file-browser">
      <div className="file-filter">
        <Search size={13} />
        <input
          aria-label="过滤项目文件"
          value={query}
          placeholder="过滤文件名…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <IconButton
          title="定位当前预览文件"
          disabled={!props.selectedFile}
          onClick={() => {
            setQuery('');
            setLocate((value) => value + 1);
          }}
        >
          <LocateFixed size={14} />
        </IconButton>
      </div>
      <div className="file-browser-tree" hidden={!!query.trim()}>
        <Directory {...props} locate={locate} />
      </div>
      {!!query.trim() && (
        <div className="file-search-results">
          {error && <p className="inline-error">{error}</p>}
          {!results.length && !error && <p className="empty-small">没有匹配的文件</p>}
          {results.map((name) => (
            <button
              className={'file-row ' + (props.selectedFile === name ? 'active' : '')}
              key={name}
              onClick={() => props.onSelect(name)}
              title={name}
            >
              <FileText size={14} />
              <span className="tree-name">{name}</span>
              <ChangeMarker change={props.changes?.find((change) => change.path === name)} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
