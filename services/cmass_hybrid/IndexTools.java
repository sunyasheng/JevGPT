import java.nio.file.*;
import java.io.IOException;
import org.apache.lucene.store.*;
import org.apache.lucene.index.*;
import io.anserini.analysis.DefaultEnglishAnalyzer;

/** Merge committed batches without duplicating immutable segment data or changing scoring. */
public class IndexTools {
  static class LinkingDirectory extends FilterDirectory {
    private final Path target;
    LinkingDirectory(Path target) throws IOException {
      super(FSDirectory.open(target)); this.target = target;
    }
    @Override public void copyFrom(Directory from, String src, String dest, IOContext context)
        throws IOException {
      Directory unwrapped = FilterDirectory.unwrap(from);
      if (!(unwrapped instanceof FSDirectory)) {
        throw new IOException("Expected a local immutable FSDirectory");
      }
      // Deliberately fail instead of silently copying hundreds of GB on another filesystem.
      Files.createLink(target.resolve(dest), ((FSDirectory) unwrapped).getDirectory().resolve(src));
    }
  }
  public static void main(String[] args) throws Exception {
    if (args[0].equals("stats")) {
      try (Directory dir = FSDirectory.open(Path.of(args[1]));
           DirectoryReader reader = DirectoryReader.open(dir)) {
        System.out.println("{\"documents\":" + reader.numDocs() + ",\"max_doc\":" + reader.maxDoc()
          + ",\"deleted\":" + reader.numDeletedDocs() + ",\"segments\":" + reader.leaves().size() + "}");
      }
    } else if (args[0].equals("merge")) {
      Path target = Path.of(args[1]);
      if (Files.exists(target)) throw new IOException("Merge target already exists: " + target);
      Files.createDirectories(target);
      try (Directory dir = new LinkingDirectory(target)) {
        IndexWriterConfig config = new IndexWriterConfig(DefaultEnglishAnalyzer.newDefaultInstance());
        config.setOpenMode(IndexWriterConfig.OpenMode.CREATE);
        config.setMergePolicy(NoMergePolicy.INSTANCE);
        config.setUseCompoundFile(false);
        try (IndexWriter writer = new IndexWriter(dir, config)) {
          for (int i = 2; i < args.length; i++) {
            try (Directory source = FSDirectory.open(Path.of(args[i]))) { writer.addIndexes(source); }
          }
          writer.commit();
        }
      }
    } else throw new IllegalArgumentException("stats INDEX | merge NEW_INDEX BATCH...");
  }
}
