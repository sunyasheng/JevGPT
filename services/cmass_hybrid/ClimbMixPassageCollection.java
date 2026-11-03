package io.anserini.collection;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;

/** Streams canonical FineWeb IDs into 250-word passages without a second text copy. */
public class ClimbMixPassageCollection extends DocumentCollection<ClimbMixPassageCollection.Passage> {
  // Python str.split/re.findall(r"\S+") Unicode whitespace, explicitly pinned.
  public static final Pattern WORD = Pattern.compile("[^\\x{0009}-\\x{000d}\\x{001c}-\\x{0020}\\x{0085}\\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}]+");
  private static final ObjectMapper JSON = new ObjectMapper();
  public ClimbMixPassageCollection() { allowedFileSuffix.add(".parquet"); }
  public ClimbMixPassageCollection(Path path) { this(); this.path=path; }
  public FileSegment<Passage> createFileSegment(Path path) throws IOException { return new Segment(path); }
  public FileSegment<Passage> createFileSegment(BufferedReader reader) { throw new UnsupportedOperationException(); }
  public static class Passage implements SourceDocument {
    final String id, text;
    Passage(String id, String text) { this.id=id; this.text=text; }
    public String id() { return id; }
    public String contents() { return text; }
    public boolean indexable() { return !text.isEmpty(); }
    public String raw() {
      try { return JSON.writeValueAsString(Map.of("id",id,"contents",text)); }
      catch (IOException e) { throw new UncheckedIOException(e); }
    }
  }
  public static class Segment extends FileSegment<Passage> {
    final FineWebCollection.Segment parent;
    final Iterator<FineWebCollection.Document> docs;
    Matcher words;
    String docid;
    int passage;
    long documents=0, passages=0;
    boolean reported=false;
    final long limit=Long.parseLong(System.getenv().getOrDefault("CMASS_SAMPLE_DOCS_PER_SHARD","0"));
    Segment(Path path) throws IOException {
      super(path); parent=new FineWebCollection.Segment(path); docs=parent.iterator();
    }
    protected void readNext() throws IOException {
      while (true) {
        if (words != null) {
          StringBuilder body=new StringBuilder();
          for (int i=0; i<250 && words.find(); i++) {
            if (i>0) body.append(' ');
            body.append(words.group());
          }
          if (!body.isEmpty()) {
            bufferedRecord=new Passage("cmasspass_"+docid+"_"+(passage++),body.toString());
            passages++; return;
          }
          words=null;
        }
        if ((limit>0 && documents>=limit) || !docs.hasNext()) {
          if (parent.getErrorStatus() || parent.getSkippedCount()!=0) throw new IOException("Parent parquet read failed");
          atEOF=true;
          if (!reported) {
            System.err.println("CMASS_SOURCE_COMPLETE "+JSON.writeValueAsString(Map.of("shard",path.getFileName().toString(),"documents",documents,"passages",passages)));
            reported=true;
          }
          throw new NoSuchElementException();
        }
        FineWebCollection.Document doc=docs.next();
        docid=doc.id(); words=WORD.matcher(doc.contents()); passage=0; documents++;
      }
    }
    public void close() { parent.close(); super.close(); }
  }
}
